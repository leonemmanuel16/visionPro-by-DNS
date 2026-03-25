"""Event Publisher - Save snapshots and publish detection events."""

import io
import json
import time
import uuid
from datetime import datetime, timezone

import asyncpg
import cv2
import numpy as np
import redis.asyncio as aioredis
import structlog
from minio import Minio
from PIL import Image

from tracker import TrackedDetection

log = structlog.get_logger()


class EventPublisher:
    """Publishes detection events to Redis Streams and stores media in MinIO."""

    DEBOUNCE_SECONDS = 30.0  # Max 1 event per camera every 30 seconds

    def __init__(
        self,
        db_pool: asyncpg.Pool,
        redis: aioredis.Redis,
        minio_endpoint: str,
        minio_access_key: str,
        minio_secret_key: str,
    ):
        self.db = db_pool
        self.redis = redis
        self.minio = Minio(
            minio_endpoint,
            access_key=minio_access_key,
            secret_key=minio_secret_key,
            secure=False,
        )
        self._last_published: dict[str, float] = {}
        self._ensure_buckets()

    def _ensure_buckets(self):
        for bucket in ["snapshots", "clips", "thumbnails"]:
            if not self.minio.bucket_exists(bucket):
                self.minio.make_bucket(bucket)

    def _should_debounce(self, camera_id: str, label: str, tracker_id: int | None = None) -> bool:
        """Check if we should skip this event (debounce).

        Uses tracker_id when available so each tracked object has its own
        debounce window.  Falls back to camera+label for untracked objects.
        """
        if tracker_id is not None:
            key = f"{camera_id}:track:{tracker_id}"
        else:
            key = f"{camera_id}:{label}"
        now = time.monotonic()
        last = self._last_published.get(key, 0)
        if now - last < self.DEBOUNCE_SECONDS:
            return True
        self._last_published[key] = now
        return False

    async def publish(
        self,
        camera_id: str,
        camera_name: str,
        detection: TrackedDetection,
        frame: np.ndarray,
    ) -> None:
        """Process and publish a detection event."""
        # Only publish new objects or after debounce (per tracker_id)
        tid = detection.tracker_id if hasattr(detection, "tracker_id") else None
        if not detection.is_new and self._should_debounce(camera_id, detection.label, tid):
            return

        event_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")

        # Save snapshot (full frame with bounding box)
        snapshot_path = await self._save_snapshot(event_id, timestamp_str, frame, detection)

        # Save thumbnail (cropped detection)
        thumbnail_path = await self._save_thumbnail(event_id, timestamp_str, frame, detection)

        # Determine event type
        event_type = detection.label
        if hasattr(detection, "metadata") and detection.metadata:
            if "zone_id" in detection.metadata:
                event_type = "zone_crossing"

        # Get zone_id if available
        zone_id = None
        metadata = {}
        if hasattr(detection, "metadata") and detection.metadata:
            zone_id = detection.metadata.get("zone_id")
            metadata = detection.metadata

        metadata["tracker_id"] = detection.tracker_id

        # Store frame dimensions so heatmap can map bbox correctly
        # (bbox is in pixel coords of the source frame resolution)
        if frame is not None:
            metadata["frame_width"] = int(frame.shape[1])
            metadata["frame_height"] = int(frame.shape[0])

        # Insert event into database
        async with self.db.acquire() as conn:
            await conn.execute(
                """INSERT INTO events
                   (id, camera_id, event_type, label, confidence, bbox,
                    zone_id, snapshot_path, thumbnail_path, metadata, occurred_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)""",
                uuid.UUID(event_id),
                uuid.UUID(camera_id),
                event_type,
                detection.label,
                detection.confidence,
                f'{{"x1":{detection.bbox[0]:.1f},"y1":{detection.bbox[1]:.1f},"x2":{detection.bbox[2]:.1f},"y2":{detection.bbox[3]:.1f}}}',
                uuid.UUID(zone_id) if zone_id else None,
                snapshot_path,
                thumbnail_path,
                json.dumps(metadata),
                now,
            )

        # Publish to Redis Stream
        event_data = {
            "event_id": event_id,
            "camera_id": camera_id,
            "camera_name": camera_name,
            "event_type": event_type,
            "label": detection.label,
            "confidence": f"{detection.confidence:.3f}",
            "snapshot_path": snapshot_path or "",
            "thumbnail_path": thumbnail_path or "",
            "occurred_at": now.isoformat(),
        }
        await self.redis.xadd("detection_events", event_data)

        log.info(
            "event.published",
            event_id=event_id,
            camera=camera_name,
            label=detection.label,
            tracker_id=getattr(detection, "tracker_id", None),
            confidence=f"{detection.confidence:.2f}",
        )

    async def publish_person_count(
        self,
        camera_id: str,
        camera_name: str,
        person_count: int,
        person_details: list[dict],
        frame: np.ndarray,
    ) -> None:
        """Publish a person_count event summarising all persons in frame.

        This fires once per frame (debounced) and includes the count and
        details of each tracked person (tracker_id, person_name, bbox).
        """
        if self._should_debounce(camera_id, "person_count"):
            return

        event_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")

        metadata = {
            "person_count": person_count,
            "persons": person_details,
        }
        if frame is not None:
            metadata["frame_width"] = int(frame.shape[1])
            metadata["frame_height"] = int(frame.shape[0])

        # Save a snapshot with ALL bounding boxes drawn
        snapshot_path = None
        try:
            annotated = frame.copy()
            for p in person_details:
                bbox = p.get("bbox")
                if bbox:
                    x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
                    name = p.get("person_name", f"Persona {p.get('tracker_id', '?')}")
                    cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(
                        annotated, name, (x1, y1 - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2,
                    )
            # Add count overlay
            cv2.putText(
                annotated, f"Personas: {person_count}", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 2,
            )
            _, buffer = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
            data = buffer.tobytes()
            object_name = f"{timestamp_str}/{event_id}_group.jpg"
            self.minio.put_object(
                "snapshots", object_name, io.BytesIO(data), len(data),
                content_type="image/jpeg",
            )
            snapshot_path = f"snapshots/{object_name}"
        except Exception as e:
            log.warning("event.group_snapshot_failed", error=str(e))

        async with self.db.acquire() as conn:
            await conn.execute(
                """INSERT INTO events
                   (id, camera_id, event_type, label, confidence, bbox,
                    zone_id, snapshot_path, thumbnail_path, metadata, occurred_at)
                   VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, NULL, $7, $8)""",
                uuid.UUID(event_id),
                uuid.UUID(camera_id),
                "person_count",
                f"{person_count} personas",
                1.0,
                snapshot_path,
                json.dumps(metadata),
                now,
            )

        await self.redis.xadd("detection_events", {
            "event_id": event_id,
            "camera_id": camera_id,
            "camera_name": camera_name,
            "event_type": "person_count",
            "label": f"{person_count} personas",
            "person_count": str(person_count),
            "occurred_at": now.isoformat(),
        })

        log.info(
            "event.person_count",
            camera=camera_name,
            count=person_count,
            names=[p.get("person_name", "?") for p in person_details],
        )

    async def _save_snapshot(
        self, event_id: str, timestamp: str, frame: np.ndarray, detection: TrackedDetection
    ) -> str | None:
        """Save annotated frame to MinIO."""
        try:
            # Draw bounding box on frame
            annotated = frame.copy()
            x1, y1, x2, y2 = [int(c) for c in detection.bbox]
            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
            label_text = f"{detection.label} {detection.confidence:.0%}"
            cv2.putText(
                annotated, label_text, (x1, y1 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2,
            )

            # Encode to JPEG
            _, buffer = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
            data = buffer.tobytes()

            object_name = f"{timestamp}/{event_id}.jpg"
            self.minio.put_object(
                "snapshots", object_name, io.BytesIO(data), len(data),
                content_type="image/jpeg",
            )
            return f"snapshots/{object_name}"
        except Exception as e:
            log.warning("event.snapshot_failed", error=str(e))
            return None

    async def _save_thumbnail(
        self, event_id: str, timestamp: str, frame: np.ndarray, detection: TrackedDetection
    ) -> str | None:
        """Save cropped detection thumbnail to MinIO."""
        try:
            x1, y1, x2, y2 = [max(0, int(c)) for c in detection.bbox]
            h, w = frame.shape[:2]
            x2, y2 = min(x2, w), min(y2, h)

            if x2 <= x1 or y2 <= y1:
                return None

            crop = frame[y1:y2, x1:x2]

            # Encode to JPEG
            _, buffer = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
            data = buffer.tobytes()

            object_name = f"{timestamp}/{event_id}_thumb.jpg"
            self.minio.put_object(
                "thumbnails", object_name, io.BytesIO(data), len(data),
                content_type="image/jpeg",
            )
            return f"thumbnails/{object_name}"
        except Exception as e:
            log.warning("event.thumbnail_failed", error=str(e))
            return None
