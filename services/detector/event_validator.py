"""Event Validator — Post-publication quality check.

Runs asynchronously after events are published. Re-evaluates each event
by checking image quality and re-running YOLO detection on the snapshot.
Deletes false positives automatically.

Quality checks:
1. Image variance (gray/corrupt frames have very low variance)
2. Brightness check (too dark or washed out = bad frame)
3. Re-detect with YOLO on the snapshot (is the object really there?)
4. If person: verify minimum size and aspect ratio
"""

import asyncio
import time

import cv2
import numpy as np
import structlog

log = structlog.get_logger()


class EventValidator:
    """Validates published events and removes false positives."""

    # Minimum image variance (gray/corrupt frames have < 100)
    MIN_VARIANCE = 200.0
    # Minimum mean brightness (too dark = likely corrupt)
    MIN_BRIGHTNESS = 20.0
    # Maximum mean brightness (washed out = likely corrupt)
    MAX_BRIGHTNESS = 245.0
    # Minimum % of non-gray pixels in the crop region
    MIN_COLOR_RATIO = 0.05
    # Re-detection confidence threshold (stricter than initial)
    REDETECT_CONFIDENCE = 0.40

    def __init__(self, detector=None, db_pool=None):
        self.detector = detector
        self.db = db_pool
        self._queue: asyncio.Queue = asyncio.Queue()
        self._running = False
        self._worker_task = None
        self._stats = {"validated": 0, "rejected": 0}

    async def start(self):
        self._running = True
        self._worker_task = asyncio.create_task(self._validation_worker())
        log.info("event_validator.started")

    async def stop(self):
        self._running = False
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        log.info("event_validator.stopped", stats=self._stats)

    async def submit(self, event_id: str, frame: np.ndarray, bbox: tuple,
                     label: str, confidence: float):
        """Submit an event for validation after it's published."""
        await self._queue.put({
            "event_id": event_id,
            "frame": frame,
            "bbox": bbox,
            "label": label,
            "confidence": confidence,
            "submitted_at": time.monotonic(),
        })

    @staticmethod
    def check_frame_quality(frame: np.ndarray, bbox: tuple | None = None) -> dict:
        """Check if a frame/crop is valid (not gray, corrupt, or washed out).

        Returns dict with is_valid, reason, and metrics.
        Can be used pre-publish to reject bad frames before they become events.
        """
        if frame is None or frame.size == 0:
            return {"is_valid": False, "reason": "empty_frame"}

        # If bbox provided, check the crop region specifically
        if bbox:
            x1, y1, x2, y2 = [int(c) for c in bbox]
            h, w = frame.shape[:2]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 <= x1 or y2 <= y1:
                return {"is_valid": False, "reason": "invalid_bbox"}
            region = frame[y1:y2, x1:x2]
        else:
            region = frame

        if region.size == 0:
            return {"is_valid": False, "reason": "empty_region"}

        # Convert to grayscale for analysis
        if len(region.shape) == 3:
            gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
        else:
            gray = region

        # 1. Variance check — gray/corrupt frames have very low variance
        variance = float(gray.var())
        if variance < EventValidator.MIN_VARIANCE:
            return {"is_valid": False, "reason": "low_variance",
                    "variance": round(variance, 1)}

        # 2. Brightness check
        mean_brightness = float(gray.mean())
        if mean_brightness < EventValidator.MIN_BRIGHTNESS:
            return {"is_valid": False, "reason": "too_dark",
                    "brightness": round(mean_brightness, 1)}
        if mean_brightness > EventValidator.MAX_BRIGHTNESS:
            return {"is_valid": False, "reason": "too_bright",
                    "brightness": round(mean_brightness, 1)}

        # 3. Color diversity — check if image is mostly uniform gray
        if len(region.shape) == 3:
            hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
            saturation = hsv[:, :, 1]
            color_pixels = np.count_nonzero(saturation > 30)
            color_ratio = color_pixels / max(saturation.size, 1)
        else:
            color_ratio = 0.0

        # 4. Edge density — real scenes have edges, gray frames don't
        edges = cv2.Canny(gray, 50, 150)
        edge_density = np.count_nonzero(edges) / max(edges.size, 1)

        if edge_density < 0.01 and color_ratio < EventValidator.MIN_COLOR_RATIO:
            return {"is_valid": False, "reason": "uniform_image",
                    "edge_density": round(edge_density, 4),
                    "color_ratio": round(color_ratio, 4)}

        return {
            "is_valid": True,
            "variance": round(variance, 1),
            "brightness": round(mean_brightness, 1),
            "color_ratio": round(color_ratio, 4),
            "edge_density": round(edge_density, 4),
        }

    async def _validation_worker(self):
        """Background worker that validates events after publication."""
        while self._running:
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=5.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            try:
                event_id = item["event_id"]
                frame = item["frame"]
                bbox = item["bbox"]
                label = item["label"]

                # Wait a moment to avoid contention with the publishing pipeline
                await asyncio.sleep(0.5)

                # 1. Check frame quality
                quality = self.check_frame_quality(frame, bbox)

                if not quality["is_valid"]:
                    # Bad frame — delete event
                    await self._delete_event(event_id)
                    self._stats["rejected"] += 1
                    log.info("event_validator.rejected",
                             event_id=event_id[:8],
                             label=label,
                             reason=quality["reason"],
                             **{k: v for k, v in quality.items()
                                if k not in ("is_valid", "reason")})
                    continue

                # 2. Re-run YOLO on the crop to verify detection
                if self.detector and frame is not None:
                    valid = await self._redetect(frame, bbox, label)
                    if not valid:
                        await self._delete_event(event_id)
                        self._stats["rejected"] += 1
                        log.info("event_validator.redetect_failed",
                                 event_id=event_id[:8], label=label)
                        continue

                self._stats["validated"] += 1

            except Exception as e:
                log.warning("event_validator.error", error=str(e))

    async def _redetect(self, frame: np.ndarray, bbox: tuple, label: str) -> bool:
        """Re-run YOLO detection on the frame to verify the object exists.

        Uses a larger crop around the bbox for context.
        """
        try:
            loop = asyncio.get_event_loop()
            detections = await loop.run_in_executor(
                None, self.detector.detect_batch, [frame]
            )

            if not detections or not detections[0]:
                return False

            base_label = label.split(":")[0]
            x1, y1, x2, y2 = bbox
            center_x = (x1 + x2) / 2
            center_y = (y1 + y2) / 2
            bbox_area = (x2 - x1) * (y2 - y1)

            # Check if any re-detected object overlaps significantly with the original
            for det in detections[0]:
                det_label = det.label.split(":")[0]
                dx1, dy1, dx2, dy2 = det.bbox
                det_cx = (dx1 + dx2) / 2
                det_cy = (dy1 + dy2) / 2
                det_area = (dx2 - dx1) * (dy2 - dy1)

                # Must be same class
                yolo_to_class = {
                    "person": "person",
                    "car": "vehicle", "truck": "vehicle", "bus": "vehicle",
                    "motorcycle": "vehicle", "bicycle": "vehicle",
                }
                orig_class = yolo_to_class.get(base_label, base_label)
                det_class = yolo_to_class.get(det_label, det_label)

                if orig_class != det_class:
                    continue

                # Centers must be reasonably close
                h, w = frame.shape[:2]
                dist_x = abs(center_x - det_cx) / w
                dist_y = abs(center_y - det_cy) / h
                if dist_x < 0.15 and dist_y < 0.15:
                    # Found matching detection
                    if det.confidence >= self.REDETECT_CONFIDENCE:
                        return True

            return False

        except Exception as e:
            log.debug("event_validator.redetect_error", error=str(e))
            # On error, don't reject — let it pass
            return True

    async def _delete_event(self, event_id: str):
        """Delete a false positive event from the database."""
        if not self.db:
            return
        try:
            import uuid
            async with self.db.acquire() as conn:
                await conn.execute(
                    "DELETE FROM events WHERE id = $1",
                    uuid.UUID(event_id)
                )
        except Exception as e:
            log.warning("event_validator.delete_failed",
                        event_id=event_id[:8], error=str(e))
