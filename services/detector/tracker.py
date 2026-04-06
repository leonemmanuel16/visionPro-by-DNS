"""Object Tracker - ByteTrack via supervision library.

Updated for mosaic architecture:
  - Configurable frame_rate (15fps default for mosaic, was 5fps)
  - Always calls ByteTrack even with 0 detections so it can expire old tracks
  - Caches tracker_id -> label mapping for coasting tracks
"""

from dataclasses import dataclass

import numpy as np
import structlog
import supervision as sv

from detector import Detection, YOLODetector

log = structlog.get_logger()


@dataclass
class TrackedDetection(Detection):
    tracker_id: int = -1
    is_new: bool = False
    metadata: dict | None = None


class ObjectTracker:
    """Tracks objects across frames using ByteTrack."""

    def __init__(self, frame_rate: int = 15):
        self.tracker = sv.ByteTrack(
            track_thresh=0.25,
            track_buffer=frame_rate * 2,  # hold lost tracks for ~2 seconds
            match_thresh=0.8,
            frame_rate=frame_rate,
        )
        self.seen_ids: set[int] = set()
        self._id_labels: dict[int, str] = {}  # tracker_id -> last known label

    def update(
        self, detections: list[Detection], frame: np.ndarray
    ) -> list[TrackedDetection]:
        """Update tracker with new detections. Returns tracked detections.

        Always calls ByteTrack even when detections is empty so that
        lost tracks can be properly aged out and coasting tracks returned.
        """
        if detections:
            xyxy = np.array([d.bbox for d in detections])
            confidence = np.array([d.confidence for d in detections])
            class_id = np.array([d.class_id for d in detections])
        else:
            xyxy = np.empty((0, 4), dtype=np.float32)
            confidence = np.empty(0, dtype=np.float32)
            class_id = np.empty(0, dtype=int)

        sv_detections = sv.Detections(
            xyxy=xyxy,
            confidence=confidence,
            class_id=class_id,
        )

        # Run tracker — this updates internal state even with 0 detections
        tracked = self.tracker.update_with_detections(sv_detections)

        results = []
        for i in range(len(tracked)):
            bbox = tuple(tracked.xyxy[i].tolist())
            tid = int(tracked.tracker_id[i]) if tracked.tracker_id is not None else -1
            cid = int(tracked.class_id[i])

            # Find label: try current detections first, then cached, then class map
            label = None
            for d in detections:
                if d.class_id == cid:
                    label = d.label
                    break
            if label is None:
                label = self._id_labels.get(tid, YOLODetector.TARGET_CLASSES.get(cid, "unknown"))

            # Cache label for this tracker_id
            if tid >= 0:
                self._id_labels[tid] = label

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
