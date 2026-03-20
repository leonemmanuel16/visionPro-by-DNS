"""Object Tracker - ByteTrack via supervision library."""

from dataclasses import dataclass

import numpy as np
import structlog
import supervision as sv

from detector import Detection

log = structlog.get_logger()


@dataclass
class TrackedDetection(Detection):
    tracker_id: int = -1
    is_new: bool = False


class ObjectTracker:
    """Tracks objects across frames using ByteTrack."""

    def __init__(self):
        self.tracker = sv.ByteTrack(
            track_activation_threshold=0.25,
            lost_track_buffer=30,
            minimum_matching_threshold=0.8,
            frame_rate=5,
        )
        self.seen_ids: set[int] = set()

    def update(
        self, detections: list[Detection], frame: np.ndarray
    ) -> list[TrackedDetection]:
        """Update tracker with new detections. Returns tracked detections."""
        if not detections:
            return []

        # Convert to supervision Detections format
        xyxy = np.array([d.bbox for d in detections])
        confidence = np.array([d.confidence for d in detections])
        class_id = np.array([d.class_id for d in detections])

        sv_detections = sv.Detections(
            xyxy=xyxy,
            confidence=confidence,
            class_id=class_id,
        )

        # Run tracker
        tracked = self.tracker.update_with_detections(sv_detections)

        results = []
        for i in range(len(tracked)):
            bbox = tuple(tracked.xyxy[i].tolist())
            tid = int(tracked.tracker_id[i]) if tracked.tracker_id is not None else -1
            cid = int(tracked.class_id[i])

            # Find original detection to get label
            label = "unknown"
            for d in detections:
                if d.class_id == cid:
                    label = d.label
                    break

            is_new = tid not in self.seen_ids
            if is_new and tid >= 0:
                self.seen_ids.add(tid)

            results.append(
                TrackedDetection(
                    bbox=bbox,
                    label=label,
                    confidence=float(tracked.confidence[i]),
                    class_id=cid,
                    tracker_id=tid,
                    is_new=is_new,
                )
            )

        return results
