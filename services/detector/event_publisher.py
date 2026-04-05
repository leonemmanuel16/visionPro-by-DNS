"""Event Publisher - Save snapshots and publish detection events.

Key behaviors:
- Vehicles (car, truck, bus, motorcycle, bicycle):
    * ONE event when first detected, then NEVER again while stationary.
    * Uses spatial deduplication: if a "new" tracker appears at the same
      position as a recently-published vehicle, it's suppressed.
    * Only re-publishes if the vehicle physically moves across the frame.
- Persons:
    * Only when face is detected (handled in main.py).
    * 10s debounce per tracker_id.
- Animals / other:
    * 30s debounce.
"""

import io
import json
import math
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


def _iou(box_a: tuple, box_b: tuple) -> float:
    """Intersection-over-Union between two (x1,y1,x2,y2) boxes."""
    xa = max(box_a[0], box_b[0])
    ya = max(box_a[1], box_b[1])
    xb = min(box_a[2], box_b[2])
    yb = min(box_a[3], box_b[3])
    inter = max(0, xb - xa) * max(0, yb - ya)
    area_a = max(0, box_a[2] - box_a[0]) * max(0, box_a[3] - box_a[1])
    area_b = max(0, box_b[2] - box_b[0]) * max(0, box_b[3] - box_b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class EventPublisher:
    """Publishes detection events to Redis Streams and stores media in MinIO."""

    # Debounce per category
    DEBOUNCE_PERSON = 10.0
    DEBOUNCE_VEHICLE = 7200.0  # 2 hours — one alert per car per tracker session
    DEBOUNCE_ANIMAL = 60.0
    DEBOUNCE_DEFAULT = 60.0

    # Labels considered vehicles
    VEHICLE_LABELS = {"car", "truck", "bus", "motorcycle", "bicycle"}

    # Spatial dedup: if a new vehicle bbox overlaps >40% with a known parked
    # vehicle, suppress the event (covers tracker_id changes for same car).
    VEHICLE_IOU_THRESHOLD = 0.40

    # Stationary check: center must move >5% of frame to be "in motion"
    MOTION_THRESHOLD_PCT = 5.0

    # How long parked-vehicle memory persists (seconds)
    PARKED_MEMORY_TTL = 7200  # 2 hours — same as debounce

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
        # Per-tracker debounce timestamps
        self._last_published: dict[str, float] = {}

        # Per-tracker last known center (for motion detection)
        self._last_center: dict[str, tuple[float, float]] = {}

        # Parked vehicle memory: camera_id → list of (bbox, timestamp)
        # If a new vehicle appears at the same spot, it's probably the same car.
        self._parked_vehicles: dict[str, list[tuple[tuple, float]]] = {}

        self._last_cleanup = time.monotonic()
        self._ensure_buckets()

    def _ensure_buckets(self):
        for bucket in ["snapshots", "clips", "thumbnails"]:
            if not self.minio.bucket_exists(bucket):
                self.minio.make_bucket(bucket)

    # ------------------------------------------------------------------
    # Vehicle spatial deduplication
    # ------------------------------------------------------------------

    def _is_duplicate_vehicle(self, camera_id: str, bbox: tuple) -> bool:
        """Check if a vehicle at this bbox was already published recently.

        Compares against a list of known parked-vehicle bboxes for this camera.
        If IoU > threshold with any known parked vehicle, it's a duplicate.
        """
        now = time.monotonic()
        parked = self._parked_vehicles.get(camera_id, [])

        # Clean expired entries
        parked = [(b, t) for b, t in parked if now - t < self.PARKED_MEMORY_TTL]
        self._parked_vehicles[camera_id] = parked

        for parked_bbox, _ in parked:
            if _iou(bbox, parked_bbox) > self.VEHICLE_IOU_THRESHOLD:
                return True
        return False

    def _remember_parked_vehicle(self, camera_id: str, bbox: tuple) -> None:
        """Remember that a vehicle was published at this bbox."""
        now = time.monotonic()
        if camera_id not in self._parked_vehicles:
            self._parked_vehicles[camera_id] = []
        self._parked_vehicles[camera_id].append((bbox, now))

    def _forget_vehicle_at(self, camera_id: str, bbox: tuple) -> None:
        """Remove a parked vehicle from memory (it moved away)."""
        parked = self._parked_vehicles.get(camera_id, [])
        self._parked_vehicles[camera_id] = [
            (b, t) for b, t in parked if _iou(b, bbox) < self.VEHICLE_IOU_THRESHOLD
        ]

    # ------------------------------------------------------------------
    # Motion detection
    # ------------------------------------------------------------------

    def _is_moving(self, camera_id: str, tracker_id: int, bbox: tuple, frame_shape: tuple) -> bool:
        """Check if a tracked object is actively moving.

        Returns True if the center has moved >MOTION_THRESHOLD_PCT since last check.
        """
        key = f"{camera_id}:center:{tracker_id}"
        cx = (bbox[0] + bbox[2]) / 2
        cy = (bbox[1] + bbox[3]) / 2

        if key not in self._last_center:
            self._last_center[key] = (cx, cy)
            return True  # First sighting = treat as moving

        prev_cx, prev_cy = self._last_center[key]
        h, w = frame_shape[:2]
        dist_pct = math.sqrt(((cx - prev_cx) / w * 100) ** 2 + ((cy - prev_cy) / h * 100) ** 2)

        self._last_center[key] = (cx, cy)
        return dist_pct > self.MOTION_THRESHOLD_PCT

    # ------------------------------------------------------------------
    # Debounce
    # ------------------------------------------------------------------

    def _get_debounce_time(self, label: str) -> float:
        base = label.split(":")[0]
        if base == "person":
            return self.DEBOUNCE_PERSON
        if base in self.VEHICLE_LABELS:
            return self.DEBOUNCE_VEHICLE
        if base in ("cat", "dog", "bird", "horse", "cow", "sheep"):
            return self.DEBOUNCE_ANIMAL
        return self.DEBOUNCE_DEFAULT

    def _should_debounce(self, camera_id: str, label: str, tracker_id: int | None = None) -> bool:
        debounce_time = self._get_debounce_time(label)
        key = f"{camera_id}:track:{tracker_id}" if tracker_id is not None else f"{camera_id}:{label}"
        now = time.monotonic()
        last = self._last_published.get(key, 0)
        if now - last < debounce_time:
            return True
        self._last_published[key] = now
        return False

    # ------------------------------------------------------------------
    # Periodic cleanup
    # ------------------------------------------------------------------

    def _cleanup_caches(self):
        now = time.monotonic()
        if now - self._last_cleanup < 300:
            return
        self._last_cleanup = now

        # Debounce cache: remove entries older than 1 hour
        stale = [k for k, v in self._last_published.items() if now - v > 3600]
        for k in stale:
            del self._last_published[k]

        # Center cache: remove old entries
        stale_c = [k for k, v in self._last_center.items() if True]  # cleared periodically
        if len(self._last_center) > 1000:
            self._last_center.clear()

        # Parked vehicles: already cleaned in _is_duplicate_vehicle

        if stale:
            log.debug("event.cache_cleanup", debounce_removed=len(stale))

    # ------------------------------------------------------------------
    # Main publish
    # ------------------------------------------------------------------

    async def publish(
        self,
        camera_id: str,
        camera_name: str,
        detection: TrackedDetection,
        frame: np.ndarray,
        clip_path: str | None = None,
    ) -> str | None:
        """Process and publish a detection event. Returns event_id if published."""
        self._cleanup_caches()

        tid = detection.tracker_id if hasattr(detection, "tracker_id") else None
        base_label = detection.label.split(":")[0]
        is_vehicle = base_label in self.VEHICLE_LABELS

        # ── VEHICLE LOGIC ──────────────────────────────────────────────
        # Goal: ONE alert when a car arrives. No more alerts while parked.
        # Re-alert ONLY when the car physically moves to a new position.
        if is_vehicle:
            moving = False
            if tid is not None and frame is not None:
                moving = self._is_moving(camera_id, tid, detection.bbox, frame.shape)

            if not moving:
                # Stationary vehicle — check if we already know about a car here
                if self._is_duplicate_vehicle(camera_id, detection.bbox):
                    return None  # Same spot as a known parked car → suppress

                # Per-tracker debounce (covers same tracker staying put)
                if self._should_debounce(camera_id, detection.label, tid):
                    return None

                # First time at this spot → publish once, then remember location
                self._remember_parked_vehicle(camera_id, detection.bbox)
                log.debug("vehicle.first_seen_parked", camera=camera_name,
                          tracker=tid, label=base_label)
            else:
                # Vehicle is actively moving — per-tracker debounce still applies
                if self._should_debounce(camera_id, detection.label, tid):
                    return None
                # It moved away from its parked spot → forget that spot
                self._forget_vehicle_at(camera_id, detection.bbox)
                log.debug("vehicle.moved", camera=camera_name,
                          tracker=tid, label=base_label)

        # ── NON-VEHICLE LOGIC ──────────────────────────────────────────
        else:
            if not detection.is_new and self._should_debounce(camera_id, detection.label, tid):
                return None

        # ── Save & publish ─────────────────────────────────────────────
        event_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")

        snapshot_path = await self._save_snapshot(event_id, timestamp_str, frame, detection)
        thumbnail_path = await self._save_thumbnail(event_id, timestamp_str, frame, detection)

        event_type = detection.label
        zone_id = None
        metadata = {}
        if hasattr(detection, "metadata") and detection.metadata:
            if "zone_id" in detection.metadata:
                event_type = "zone_crossing"
            zone_id = detection.metadata.get("zone_id")
            metadata = detection.metadata

        metadata["tracker_id"] = detection.tracker_id
        if clip_path:
            metadata["clip_path"] = clip_path

        if frame is not None:
            metadata["frame_width"] = int(frame.shape[1])
            metadata["frame_height"] = int(frame.shape[0])

        # Mark if vehicle was moving
        if is_vehicle:
            metadata["vehicle_moving"] = tid is not None and frame is not None and self._is_moving(
                camera_id, tid, detection.bbox, frame.shape
            )

        async with self.db.acquire() as conn:
            await conn.execute(
                """INSERT INTO events
                   (id, camera_id, event_type, label, confidence, bbox,
                    zone_id, snapshot_path, clip_path, thumbnail_path, metadata, occurred_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)""",
                uuid.UUID(event_id),
                uuid.UUID(camera_id),
                event_type,
                detection.label,
                detection.confidence,
                f'{{"x1":{detection.bbox[0]:.1f},"y1":{detection.bbox[1]:.1f},"x2":{detection.bbox[2]:.1f},"y2":{detection.bbox[3]:.1f}}}',
                uuid.UUID(zone_id) if zone_id else None,
                snapshot_path,
                clip_path,
                thumbnail_path,
                json.dumps(metadata),
                now,
            )

        event_data = {
            "event_id": event_id,
            "camera_id": camera_id,
            "camera_name": camera_name,
            "event_type": event_type,
            "label": detection.label,
            "confidence": f"{detection.confidence:.3f}",
            "snapshot_path": snapshot_path or "",
            "thumbnail_path": thumbnail_path or "",
            "clip_path": clip_path or "",
            "occurred_at": now.isoformat(),
        }
        await self.redis.xadd("detection_events", event_data)

        log.info(
            "event.published",
            event_id=event_id,
            camera=camera_name,
            label=detection.label,
            tracker_id=tid,
            confidence=f"{detection.confidence:.2f}",
            moving=metadata.get("vehicle_moving") if is_vehicle else None,
        )

        return event_id

    # ------------------------------------------------------------------
    # Person count
    # ------------------------------------------------------------------

    async def publish_person_count(
        self,
        camera_id: str,
        camera_name: str,
        person_count: int,
        person_details: list[dict],
        frame: np.ndarray,
    ) -> None:
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
        )

    # ------------------------------------------------------------------
    # Media helpers
    # ------------------------------------------------------------------

    async def _save_snapshot(
        self, event_id: str, timestamp: str, frame: np.ndarray, detection: TrackedDetection
    ) -> str | None:
        try:
            annotated = frame.copy()
            x1, y1, x2, y2 = [int(c) for c in detection.bbox]
            cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
            label_text = f"{detection.label} {detection.confidence:.0%}"
            cv2.putText(
                annotated, label_text, (x1, y1 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2,
            )
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
        try:
            x1, y1, x2, y2 = [max(0, int(c)) for c in detection.bbox]
            h, w = frame.shape[:2]
            x2, y2 = min(x2, w), min(y2, h)
            if x2 <= x1 or y2 <= y1:
                return None
            crop = frame[y1:y2, x1:x2]
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
