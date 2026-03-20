"""YOLO Detection Wrapper."""

import time
from dataclasses import dataclass

import numpy as np
import structlog
import torch
from ultralytics import YOLO

log = structlog.get_logger()


@dataclass
class Detection:
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2
    label: str
    confidence: float
    class_id: int


class YOLODetector:
    """YOLOv10 inference wrapper."""

    # COCO classes we care about
    TARGET_CLASSES = {
        0: "person",
        1: "bicycle",
        2: "car",
        3: "motorcycle",
        5: "bus",
        7: "truck",
        14: "bird",
        15: "cat",
        16: "dog",
        17: "horse",
        18: "sheep",
        19: "cow",
    }

    def __init__(
        self,
        model_name: str = "yolov10n",
        confidence: float = 0.5,
        device: str = "auto",
    ):
        self.confidence = confidence

        # Auto-detect device
        if device == "auto":
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = device

        log.info("detector.loading_model", model=model_name, device=self.device)

        # Load model (auto-downloads if not present)
        self.model = YOLO(f"{model_name}.pt")
        self.model.to(self.device)

        # Warm up
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        self.model.predict(dummy, verbose=False)

        log.info("detector.model_ready", model=model_name, device=self.device)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Run YOLO inference on a frame. Returns list of detections."""
        start = time.monotonic()

        results = self.model.predict(
            frame,
            conf=self.confidence,
            verbose=False,
            classes=list(self.TARGET_CLASSES.keys()),
        )

        detections = []
        if results and results[0].boxes is not None:
            boxes = results[0].boxes
            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i])
                if cls_id not in self.TARGET_CLASSES:
                    continue

                bbox = boxes.xyxy[i].cpu().numpy()
                conf = float(boxes.conf[i])

                detections.append(
                    Detection(
                        bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
                        label=self.TARGET_CLASSES[cls_id],
                        confidence=conf,
                        class_id=cls_id,
                    )
                )

        elapsed = (time.monotonic() - start) * 1000
        if detections:
            log.debug("detector.inference", count=len(detections), ms=f"{elapsed:.1f}")

        return detections
