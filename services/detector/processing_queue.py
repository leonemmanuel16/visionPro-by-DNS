"""Processing Queue — Deep analysis on 4MP frames in background.

When an alert fires, the 4MP frame is enqueued here for:
  1. Face recognition at full resolution (4MP >> 640x360)
  2. Re-extraction of person/vehicle attributes at high quality
  3. Update the event record in Postgres with results

This runs asynchronously — zero impact on the 10fps detection loop.
"""

import asyncio
import json
from dataclasses import dataclass

import numpy as np
import structlog

log = structlog.get_logger()


@dataclass
class QueueItem:
    event_id: str
    camera_id: str
    frame: np.ndarray       # 4MP frame
    bbox: tuple             # bbox in 4MP coordinates
    label: str              # e.g. "person", "car"
    tracker_id: int
    metadata: dict


class ProcessingQueue:
    """Async queue that processes 4MP frames in background."""

    def __init__(self, db_pool, face_recognizer, max_size: int = 50):
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=max_size)
        self._db_pool = db_pool
        self._face_recognizer = face_recognizer
        self._running = False
        self._worker_task: asyncio.Task | None = None

    async def start(self):
        self._running = True
        self._worker_task = asyncio.create_task(self._worker())
        log.info("processing_queue.started")

    async def stop(self):
        self._running = False
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        log.info("processing_queue.stopped")

    async def enqueue(self, item: QueueItem):
        """Add a 4MP frame to the processing queue. Non-blocking, drops if full."""
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            log.warning("processing_queue.full", event_id=item.event_id)

    async def _worker(self):
        """Background worker — consumes items and runs deep processing."""
        while self._running:
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            try:
                await self._process(item)
            except Exception as e:
                log.error("processing_queue.error",
                          event_id=item.event_id, error=str(e))

    async def _process(self, item: QueueItem):
        """Run deep analysis on a single 4MP frame and update the event."""
        updates = {}
        base_label = item.label.split(":")[0]

        # ── Face recognition on 4MP (persons only) ──
        if base_label == "person" and self._face_recognizer.available:
            try:
                result = await self._face_recognizer.recognize(
                    item.frame, item.bbox
                )
                if result and result.person_id:
                    updates["person_id"] = result.person_id
                    updates["person_name"] = result.person_name
                    updates["face_confidence_hires"] = round(result.confidence, 3)
                    log.info("processing_queue.face_match",
                             event_id=item.event_id,
                             person=result.person_name,
                             confidence=f"{result.confidence:.3f}",
                             resolution=f"{item.frame.shape[1]}x{item.frame.shape[0]}")
                elif result:
                    updates["face_detected_hires"] = True
                    log.info("processing_queue.face_unknown",
                             event_id=item.event_id)
            except Exception as e:
                log.debug("processing_queue.face_error", error=str(e))

        # ── Re-extract person attributes on 4MP crop ──
        if base_label == "person":
            try:
                from person_attributes import extract_person_attributes
                from event_validator import EventValidator
                quality = EventValidator.check_frame_quality(item.frame, item.bbox)
                if quality["is_valid"] and quality.get("variance", 0) >= 400:
                    attrs = extract_person_attributes(item.frame, item.bbox)
                    updates["upper_color_hires"] = attrs["upper_color"]
                    updates["lower_color_hires"] = attrs["lower_color"]
                    updates["headgear_hires"] = attrs["headgear"]
            except Exception:
                pass

        # ── Re-extract vehicle attributes on 4MP crop ──
        if base_label in ("car", "truck", "bus", "motorcycle", "bicycle"):
            try:
                from vehicle_attributes import extract_vehicle_attributes
                from event_validator import EventValidator
                quality = EventValidator.check_frame_quality(item.frame, item.bbox)
                if quality["is_valid"]:
                    vattrs = extract_vehicle_attributes(
                        item.frame, item.bbox, yolo_label=base_label
                    )
                    updates["vehicle_color_hires"] = vattrs["vehicle_color"]
                    updates["vehicle_type_hires"] = vattrs["vehicle_type"]
                    if vattrs.get("license_plate"):
                        updates["license_plate_hires"] = vattrs["license_plate"]
            except Exception:
                pass

        # ── Update event in database ──
        if updates:
            try:
                async with self._db_pool.acquire() as conn:
                    # Merge updates into existing metadata JSONB
                    current = await conn.fetchval(
                        "SELECT metadata FROM events WHERE id = $1",
                        item.event_id,
                    )
                    meta = json.loads(current) if current else {}
                    meta.update(updates)

                    # Also update top-level label if person was identified
                    if "person_name" in updates:
                        await conn.execute(
                            "UPDATE events SET metadata = $1::jsonb, "
                            "label = $2 WHERE id = $3",
                            json.dumps(meta),
                            f"person:{updates['person_name']}",
                            item.event_id,
                        )
                    else:
                        await conn.execute(
                            "UPDATE events SET metadata = $1::jsonb WHERE id = $2",
                            json.dumps(meta),
                            item.event_id,
                        )

                    log.info("processing_queue.event_updated",
                             event_id=item.event_id,
                             updates=list(updates.keys()))

                    # Publish update to Redis so dashboard can refresh
                    # (reuse the detection_events stream)
                    try:
                        import redis.asyncio as aioredis
                        # Use the db_pool's connection info to get redis
                        # Actually, we need redis passed in. For now, log only.
                        pass
                    except Exception:
                        pass

            except Exception as e:
                log.error("processing_queue.db_error",
                          event_id=item.event_id, error=str(e))
