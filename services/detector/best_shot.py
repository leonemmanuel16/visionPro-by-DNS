"""Best-Shot Selector — ONE alert per object, period.

Brutal simplicity:
1. Track every object by tracker_id
2. Accumulate frames silently (no events published)
3. When the object LEAVES the scene (tracker gone for N frames),
   pick the single best frame and publish ONE event
4. Use spatial dedup so the same parked car never re-triggers

The key insight: don't publish while tracking. Only publish AFTER
the object has come and gone, with the single best image.

For fast-moving objects, also publish after a max timeout (8 seconds)
so alerts aren't delayed forever.

Optimization: stores only a padded crop during accumulation (~100KB vs ~6MB full frame).
The full frame is captured once at publish time via collect(current_frame=...).
"""

import time
from dataclasses import dataclass

import numpy as np
import structlog

log = structlog.get_logger()


@dataclass
class Candidate:
    """Best frame candidate for a tracked object."""
    crop: np.ndarray          # Padded crop around bbox (small, ~100KB)
    crop_offset: tuple        # (cx1, cy1) — offset of crop within original frame
    frame: np.ndarray | None  # Full frame — only set at publish time
    bbox: tuple
    bbox_area: float
    confidence: float
    metadata: dict
    score: float
    timestamp: float


@dataclass
class TrackBuffer:
    """Accumulation buffer for one tracked object."""
    tracker_id: int
    label: str
    class_id: int
    best: Candidate | None = None
    first_seen: float = 0.0
    last_seen: float = 0.0
    frame_count: int = 0


class BestShotSelector:
    """Accumulates detections, publishes ONE event per object with the best frame.

    Args:
        min_bbox_area: Ignore objects smaller than this (pixels²)
        min_person_height: Persons shorter than this are ignored (pixels)
        max_hold_time: Maximum seconds to hold before publishing (timeout)
        gone_frames: After this many frames without seeing the object, publish
        confidence_threshold: Minimum confidence to consider publishing
    """

    def __init__(
        self,
        min_bbox_area: int = 12000,
        min_person_height: int = 120,
        max_hold_time: float = 8.0,
        gone_frames: int = 15,
        confidence_threshold: float = 0.5,
    ):
        self.min_bbox_area = min_bbox_area
        self.min_person_height = min_person_height
        self.max_hold_time = max_hold_time
        self.gone_frames = gone_frames
        self.confidence_threshold = confidence_threshold

        # Active tracking buffers: camera:tracker_id → TrackBuffer
        self._buffers: dict[str, TrackBuffer] = {}

        # Already-published: camera:tracker_id → True
        self._published: set[str] = set()

        # Spatial memory: camera → list of (bbox_center, timestamp)
        self._spatial_memory: dict[str, list[tuple[tuple[float, float], float]]] = {}
        self.SPATIAL_RADIUS_PCT = 5.0
        self.SPATIAL_MEMORY_TTL = 300

        self._frame_counter: dict[str, int] = {}
        self._last_cleanup = time.monotonic()

    def _key(self, camera_id: str, tracker_id: int) -> str:
        return f"{camera_id}:{tracker_id}"

    def _bbox_center(self, bbox: tuple) -> tuple[float, float]:
        return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)

    @staticmethod
    def _padded_crop(frame: np.ndarray, bbox: tuple, pad_pct: float = 0.2) -> tuple[np.ndarray, tuple]:
        """Crop region around bbox with padding. Returns (crop, (cx1, cy1)).

        A 200x400 person bbox with 20% padding → ~280x560 crop (~470KB vs ~6MB full 1080p).
        """
        x1, y1, x2, y2 = [int(c) for c in bbox]
        h, w = frame.shape[:2]
        bw, bh = x2 - x1, y2 - y1
        pad_x = int(bw * pad_pct)
        pad_y = int(bh * pad_pct)
        cx1 = max(0, x1 - pad_x)
        cy1 = max(0, y1 - pad_y)
        cx2 = min(w, x2 + pad_x)
        cy2 = min(h, y2 + pad_y)
        return frame[cy1:cy2, cx1:cx2].copy(), (cx1, cy1)

    def _is_near_published(self, camera_id: str, center: tuple[float, float], frame_shape: tuple) -> bool:
        """Check if this position was recently published (spatial dedup)."""
        now = time.monotonic()
        memory = self._spatial_memory.get(camera_id, [])
        memory = [(c, t) for c, t in memory if now - t < self.SPATIAL_MEMORY_TTL]
        self._spatial_memory[camera_id] = memory

        h, w = frame_shape[:2]
        threshold = self.SPATIAL_RADIUS_PCT / 100

        for prev_center, _ in memory:
            dx = abs(center[0] - prev_center[0]) / w
            dy = abs(center[1] - prev_center[1]) / h
            if dx < threshold and dy < threshold:
                return True
        return False

    def _remember_position(self, camera_id: str, center: tuple[float, float]):
        """Remember that we published an event at this position."""
        if camera_id not in self._spatial_memory:
            self._spatial_memory[camera_id] = []
        self._spatial_memory[camera_id].append((center, time.monotonic()))

    def _compute_score(self, confidence: float, bbox_area: float, metadata: dict) -> float:
        """Score a frame. Higher = better candidate for the ONE alert."""
        score = bbox_area * 0.001
        score += confidence * 100
        if metadata.get("person_name"):
            score += 500
        if metadata.get("face_detected"):
            score += 200
        try:
            fc = float(metadata.get("face_confidence", 0))
            score += fc * 300
        except (ValueError, TypeError):
            pass
        if metadata.get("license_plate"):
            score += 400
        return score

    def update(
        self,
        camera_id: str,
        tracker_id: int,
        label: str,
        class_id: int,
        frame: np.ndarray,
        bbox: tuple,
        confidence: float,
        metadata: dict | None = None,
    ) -> None:
        """Feed a detection. Does NOT return anything — call collect() to get ready events."""
        key = self._key(camera_id, tracker_id)
        now = time.monotonic()
        metadata = metadata or {}

        if key in self._published:
            return

        center = self._bbox_center(bbox)
        if key not in self._buffers:
            if self._is_near_published(camera_id, center, frame.shape):
                self._published.add(key)
                return

        x1, y1, x2, y2 = bbox
        bbox_w = x2 - x1
        bbox_h = y2 - y1
        bbox_area = bbox_w * bbox_h
        base_label = label.split(":")[0]

        if bbox_area < self.min_bbox_area:
            return
        if base_label == "person" and bbox_h < self.min_person_height:
            return

        if key not in self._buffers:
            self._buffers[key] = TrackBuffer(
                tracker_id=tracker_id,
                label=label,
                class_id=class_id,
                first_seen=now,
                last_seen=now,
            )

        buf = self._buffers[key]
        buf.last_seen = now
        buf.frame_count += 1
        buf.label = label

        score = self._compute_score(confidence, bbox_area, metadata)

        # Store only a padded crop during accumulation — not the full 6MB frame
        if buf.best is None or score > buf.best.score:
            crop, offset = self._padded_crop(frame, bbox)
            buf.best = Candidate(
                crop=crop,
                crop_offset=offset,
                frame=None,  # Full frame set at publish time
                bbox=bbox,
                bbox_area=bbox_area,
                confidence=confidence,
                metadata=dict(metadata),
                score=score,
                timestamp=now,
            )

    def collect(
        self,
        camera_id: str,
        current_tracker_ids: set[int],
        current_frame: np.ndarray | None = None,
    ) -> list[tuple[TrackBuffer, Candidate]]:
        """Collect ready-to-publish events.

        Call this after processing all detections in a frame.
        Pass current_frame so we can attach the full frame for snapshot generation.

        An object is ready when:
        1. Its tracker_id is no longer in current_tracker_ids (object left), OR
        2. It has been tracked for longer than max_hold_time (timeout)
        """
        now = time.monotonic()
        ready: list[tuple[TrackBuffer, Candidate]] = []
        to_remove: list[str] = []

        for key, buf in self._buffers.items():
            cam_id = key.rsplit(":", 1)[0]
            if cam_id != camera_id:
                continue

            has_left = buf.tracker_id not in current_tracker_ids
            timed_out = (now - buf.first_seen) >= self.max_hold_time
            high_conf = buf.best and buf.best.score > 800

            if (has_left or timed_out or high_conf) and buf.best is not None:
                if buf.best.confidence >= self.confidence_threshold:
                    # Attach full frame for snapshot: use current_frame (or the crop as fallback)
                    if current_frame is not None:
                        buf.best.frame = current_frame.copy()
                    else:
                        # Fallback: use crop (snapshot will be cropped only)
                        buf.best.frame = buf.best.crop

                    ready.append((buf, buf.best))

                    center = self._bbox_center(buf.best.bbox)
                    self._remember_position(camera_id, center)
                    self._published.add(key)

                    log.info(
                        "best_shot.publish",
                        tracker_id=buf.tracker_id,
                        label=buf.label,
                        score=f"{buf.best.score:.0f}",
                        frames=buf.frame_count,
                        elapsed=f"{now - buf.first_seen:.1f}s",
                        reason="left" if has_left else "high_conf" if high_conf else "timeout",
                        plate=buf.best.metadata.get("license_plate"),
                    )

                to_remove.append(key)

        for key in to_remove:
            del self._buffers[key]

        return ready

    def cleanup(self):
        """Periodic cleanup of stale data."""
        now = time.monotonic()
        if now - self._last_cleanup < 60:
            return
        self._last_cleanup = now

        stale = [k for k, b in self._buffers.items() if now - b.last_seen > 30]
        for k in stale:
            del self._buffers[k]

        if len(self._published) > 5000:
            self._published.clear()

        for cam_id in list(self._spatial_memory.keys()):
            self._spatial_memory[cam_id] = [
                (c, t) for c, t in self._spatial_memory[cam_id]
                if now - t < self.SPATIAL_MEMORY_TTL
            ]
