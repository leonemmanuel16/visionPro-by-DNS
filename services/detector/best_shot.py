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

        # Spatial memory: camera → list of (bbox_center, label, timestamp)
        self._spatial_memory: dict[str, list[tuple[tuple[float, float], str, float]]] = {}
        self.SPATIAL_RADIUS_PCT = 8.0   # 8% of frame — wider radius to catch moving objects
        self.SPATIAL_MEMORY_TTL_VEHICLE = 86400  # 24 hours — parked cars NEVER re-trigger
        self.SPATIAL_MEMORY_TTL_DEFAULT = 86400  # 24 hours — same for persons at same position

        # Per-camera per-class cooldown: camera:class → last_publish_time
        # Prevents multiple alerts for the same type of object passing through
        self._class_cooldown: dict[str, float] = {}
        self.CLASS_COOLDOWN_VEHICLE = 30.0  # 30s — one vehicle alert per camera per 30s
        self.CLASS_COOLDOWN_PERSON = 15.0   # 15s — one person alert per camera per 15s
        self.CLASS_COOLDOWN_DEFAULT = 10.0  # 10s — other classes

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

    VEHICLE_LABELS = {"car", "truck", "bus", "motorcycle", "bicycle"}

    def _spatial_ttl(self, label: str) -> float:
        """Return spatial memory TTL based on object class."""
        base = label.split(":")[0]
        if base in self.VEHICLE_LABELS:
            return self.SPATIAL_MEMORY_TTL_VEHICLE
        return self.SPATIAL_MEMORY_TTL_DEFAULT

    def _class_cooldown_seconds(self, label: str) -> float:
        """Cooldown duration per class type."""
        base = label.split(":")[0]
        if base in self.VEHICLE_LABELS:
            return self.CLASS_COOLDOWN_VEHICLE
        if base == "person":
            return self.CLASS_COOLDOWN_PERSON
        return self.CLASS_COOLDOWN_DEFAULT

    def _is_on_cooldown(self, camera_id: str, label: str) -> bool:
        """Check if this camera+class is in cooldown (recently published)."""
        base = label.split(":")[0]
        # Map to general class (car/truck/bus → vehicle)
        if base in self.VEHICLE_LABELS:
            cls = "vehicle"
        else:
            cls = base
        key = f"{camera_id}:{cls}"
        last = self._class_cooldown.get(key, 0)
        return (time.monotonic() - last) < self._class_cooldown_seconds(label)

    def _set_cooldown(self, camera_id: str, label: str):
        """Mark this camera+class as just published."""
        base = label.split(":")[0]
        if base in self.VEHICLE_LABELS:
            cls = "vehicle"
        else:
            cls = base
        self._class_cooldown[f"{camera_id}:{cls}"] = time.monotonic()

    def _is_near_published(self, camera_id: str, center: tuple[float, float],
                           frame_shape: tuple, label: str = "") -> bool:
        """Check if this position was recently published for the same class (spatial dedup).

        Only suppresses if the SAME class was published nearby. A person and a car
        at the same position should both generate events.
        Vehicles use 1-hour TTL (parked cars), others use 2-minute TTL.
        """
        now = time.monotonic()
        base_label = label.split(":")[0]
        # Use the longest possible TTL for cleanup (vehicle TTL)
        max_ttl = self.SPATIAL_MEMORY_TTL_VEHICLE
        memory = self._spatial_memory.get(camera_id, [])
        memory = [(c, l, t) for c, l, t in memory if now - t < max_ttl]
        self._spatial_memory[camera_id] = memory

        h, w = frame_shape[:2]
        threshold = self.SPATIAL_RADIUS_PCT / 100

        for prev_center, prev_label, ts in memory:
            prev_base = prev_label.split(":")[0]
            # Only suppress same class at same position
            if prev_base != base_label:
                continue
            # Check if this memory entry is still valid for this class
            ttl = self._spatial_ttl(prev_label)
            if now - ts >= ttl:
                continue  # Expired for this class type
            dx = abs(center[0] - prev_center[0]) / w
            dy = abs(center[1] - prev_center[1]) / h
            if dx < threshold and dy < threshold:
                return True
        return False

    def _remember_position(self, camera_id: str, center: tuple[float, float], label: str = ""):
        """Remember that we published an event at this position."""
        if camera_id not in self._spatial_memory:
            self._spatial_memory[camera_id] = []
        self._spatial_memory[camera_id].append((center, label, time.monotonic()))

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
            if self._is_near_published(camera_id, center, frame.shape, label):
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

            if (has_left or timed_out) and buf.best is not None:
                if buf.best.confidence >= self.confidence_threshold:
                    # Per-camera per-class cooldown: only 1 vehicle per 30s, 1 person per 15s
                    if self._is_on_cooldown(camera_id, buf.label):
                        log.debug("best_shot.cooldown_suppressed",
                                  tracker_id=buf.tracker_id, label=buf.label)
                        self._published.add(key)
                        to_remove.append(key)
                        continue

                    # Attach full frame for snapshot: use current_frame (or the crop as fallback)
                    if current_frame is not None:
                        buf.best.frame = current_frame.copy()
                    else:
                        # Fallback: use crop (snapshot will be cropped only)
                        buf.best.frame = buf.best.crop

                    ready.append((buf, buf.best))

                    center = self._bbox_center(buf.best.bbox)
                    self._remember_position(camera_id, center, buf.label)
                    self._published.add(key)
                    self._set_cooldown(camera_id, buf.label)

                    log.info(
                        "best_shot.publish",
                        tracker_id=buf.tracker_id,
                        label=buf.label,
                        score=f"{buf.best.score:.0f}",
                        frames=buf.frame_count,
                        elapsed=f"{now - buf.first_seen:.1f}s",
                        reason="left" if has_left else "timeout",
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
                entry for entry in self._spatial_memory[cam_id]
                if now - entry[-1] < self.SPATIAL_MEMORY_TTL_VEHICLE  # use max TTL
            ]
