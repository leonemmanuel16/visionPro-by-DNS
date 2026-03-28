"""Best-Shot Selector — Wait, track, and pick the best frame before alerting.

Instead of sending an alert the moment a person or vehicle is first detected
(often far away and blurry), this module accumulates detections for each
tracker_id across multiple frames and only triggers a "publish" when:

1. The person/vehicle is close enough (bbox large enough)
2. Face confidence is high enough (for persons)
3. The best frame (sharpest, largest bbox, highest confidence) is selected

Flow:
  - Each tracked object accumulates "candidates" over time.
  - A candidate = (frame crop, bbox size, face confidence, overall score).
  - After a configurable accumulation window OR when the object starts
    leaving (bbox shrinking), we pick the best candidate and publish.
"""

import time
from dataclasses import dataclass, field

import numpy as np
import structlog

log = structlog.get_logger()


@dataclass
class ShotCandidate:
    """One candidate frame for a tracked object."""
    frame: np.ndarray          # Full frame (reference, not copy for memory)
    bbox: tuple                # (x1, y1, x2, y2)
    bbox_area: float           # Area in pixels
    confidence: float          # YOLO detection confidence
    face_confidence: float     # Face recognition confidence (0 if no face)
    person_name: str | None    # Recognized person name (if any)
    person_id: str | None      # Recognized person ID (if any)
    face_detected: bool        # Whether a face was found
    metadata: dict             # Full metadata dict
    timestamp: float           # monotonic time
    score: float = 0.0         # Computed quality score


@dataclass
class TrackerAccumulator:
    """Accumulates candidates for a single tracked object."""
    tracker_id: int
    label: str
    camera_id: str
    first_seen: float = field(default_factory=time.monotonic)
    last_seen: float = field(default_factory=time.monotonic)
    candidates: list[ShotCandidate] = field(default_factory=list)
    published: bool = False
    last_bbox_area: float = 0.0
    shrinking_frames: int = 0  # Count of consecutive frames where bbox is shrinking
    max_candidates: int = 30   # Keep at most N candidates (memory limit)


class BestShotSelector:
    """Accumulates detections and selects the best frame to publish.

    Parameters:
        min_bbox_area: Minimum bbox area (pixels) before considering a shot.
        min_person_height: Minimum person bbox height in pixels.
        accumulation_window: Seconds to accumulate before publishing.
        shrink_threshold: After N consecutive shrinking frames, publish best shot.
        min_face_confidence: Minimum face confidence to prefer face shots.
    """

    def __init__(
        self,
        min_bbox_area: int = 15000,      # ~150x100 pixels minimum
        min_person_height: int = 150,     # Person must be at least 150px tall
        accumulation_window: float = 5.0, # Wait 5 seconds to accumulate
        shrink_threshold: int = 5,        # After 5 shrinking frames, publish
        min_face_confidence: float = 0.4, # Minimum face recognition confidence
    ):
        self.min_bbox_area = min_bbox_area
        self.min_person_height = min_person_height
        self.accumulation_window = accumulation_window
        self.shrink_threshold = shrink_threshold
        self.min_face_confidence = min_face_confidence

        # Active accumulators: key = "camera_id:tracker_id"
        self._accumulators: dict[str, TrackerAccumulator] = {}

        # Published tracker IDs per camera (to avoid re-publishing)
        self._published_ids: dict[str, set[int]] = {}

        self._last_cleanup = time.monotonic()

    def _key(self, camera_id: str, tracker_id: int) -> str:
        return f"{camera_id}:{tracker_id}"

    def add_candidate(
        self,
        camera_id: str,
        tracker_id: int,
        label: str,
        frame: np.ndarray,
        bbox: tuple,
        confidence: float,
        metadata: dict | None = None,
    ) -> ShotCandidate | None:
        """Add a detection frame as a candidate. Returns the best ShotCandidate
        if it's time to publish, or None if still accumulating.

        The caller should only publish the returned candidate (not every frame).
        """
        key = self._key(camera_id, tracker_id)
        now = time.monotonic()
        metadata = metadata or {}

        # Already published this tracker — skip
        if camera_id in self._published_ids and tracker_id in self._published_ids[camera_id]:
            return None

        # Calculate bbox properties
        x1, y1, x2, y2 = bbox
        bbox_w = x2 - x1
        bbox_h = y2 - y1
        bbox_area = bbox_w * bbox_h

        # Create or get accumulator
        if key not in self._accumulators:
            self._accumulators[key] = TrackerAccumulator(
                tracker_id=tracker_id,
                label=label,
                camera_id=camera_id,
            )

        acc = self._accumulators[key]
        acc.last_seen = now

        # Track if bbox is shrinking (object moving away)
        if bbox_area < acc.last_bbox_area * 0.95:  # 5% smaller
            acc.shrinking_frames += 1
        else:
            acc.shrinking_frames = 0
        acc.last_bbox_area = bbox_area

        # Extract face info from metadata
        face_confidence = 0.0
        face_detected = metadata.get("face_detected", False)
        person_name = metadata.get("person_name")
        person_id = metadata.get("person_id")
        if metadata.get("face_confidence"):
            try:
                face_confidence = float(metadata["face_confidence"])
            except (ValueError, TypeError):
                pass

        # Compute quality score:
        #   - Larger bbox = closer = better image quality
        #   - Higher face confidence = better identification
        #   - Face detected at all = bonus
        #   - Higher YOLO confidence = more certain detection
        score = (
            bbox_area * 0.001              # Size contribution (bigger = better)
            + confidence * 50              # Detection confidence
            + face_confidence * 200        # Face match confidence (most important)
            + (100 if face_detected else 0)  # Bonus for detecting a face at all
            + (300 if person_name else 0)  # Big bonus for recognized person
        )

        # Only add as candidate if bbox is large enough
        base_label = label.split(":")[0]
        if base_label == "person" and bbox_h < self.min_person_height:
            return None  # Person too small, keep waiting
        if bbox_area < self.min_bbox_area:
            return None  # Object too small

        candidate = ShotCandidate(
            frame=frame.copy(),  # Copy frame since it changes each iteration
            bbox=bbox,
            bbox_area=bbox_area,
            confidence=confidence,
            face_confidence=face_confidence,
            person_name=person_name,
            person_id=person_id,
            face_detected=face_detected,
            metadata=dict(metadata),
            timestamp=now,
            score=score,
        )

        # Add candidate, keeping only the best N
        acc.candidates.append(candidate)
        if len(acc.candidates) > acc.max_candidates:
            # Keep only the top candidates by score
            acc.candidates.sort(key=lambda c: c.score, reverse=True)
            acc.candidates = acc.candidates[:acc.max_candidates]

        # --- Decide if we should publish now ---

        elapsed = now - acc.first_seen

        # Condition 1: Object is leaving (bbox shrinking for N frames)
        leaving = acc.shrinking_frames >= self.shrink_threshold

        # Condition 2: Accumulation window elapsed
        window_done = elapsed >= self.accumulation_window

        # Condition 3: Very high confidence face match (no need to wait more)
        high_conf_face = (person_name is not None and face_confidence > 0.5)

        should_publish = leaving or window_done or high_conf_face

        if should_publish and acc.candidates:
            # Pick the best candidate
            best = max(acc.candidates, key=lambda c: c.score)

            # For persons: prefer candidates that have face detected
            face_candidates = [c for c in acc.candidates if c.face_detected]
            if face_candidates:
                best = max(face_candidates, key=lambda c: c.score)

            # Mark as published
            acc.published = True
            if camera_id not in self._published_ids:
                self._published_ids[camera_id] = set()
            self._published_ids[camera_id].add(tracker_id)

            # Cleanup this accumulator
            del self._accumulators[key]

            log.info(
                "best_shot.selected",
                tracker_id=tracker_id,
                label=label,
                score=f"{best.score:.0f}",
                bbox_area=f"{best.bbox_area:.0f}",
                face=best.face_detected,
                person=best.person_name,
                candidates_evaluated=len(acc.candidates),
                elapsed=f"{elapsed:.1f}s",
                reason="leaving" if leaving else "high_conf" if high_conf_face else "window",
            )

            return best

        return None  # Still accumulating

    def cleanup(self):
        """Remove stale accumulators and old published IDs."""
        now = time.monotonic()
        if now - self._last_cleanup < 30:
            return
        self._last_cleanup = now

        # Remove accumulators that haven't been seen for >30 seconds
        stale = [k for k, v in self._accumulators.items() if now - v.last_seen > 30]
        for k in stale:
            # Publish best shot from stale accumulator before removing
            acc = self._accumulators[k]
            if acc.candidates and not acc.published:
                log.debug("best_shot.stale_discard", tracker_id=acc.tracker_id, candidates=len(acc.candidates))
            del self._accumulators[k]

        # Clear published IDs older than 10 minutes (allow re-detection)
        if len(self._published_ids) > 100:
            self._published_ids.clear()

    def reset_tracker(self, camera_id: str, tracker_id: int):
        """Allow re-publishing for a tracker (e.g., if it re-enters the scene)."""
        if camera_id in self._published_ids:
            self._published_ids[camera_id].discard(tracker_id)
        key = self._key(camera_id, tracker_id)
        self._accumulators.pop(key, None)
