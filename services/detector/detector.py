"""YOLO Detection Wrapper."""

import os
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
    """YOLO inference wrapper with NVIDIA GPU acceleration.

    Supports YOLOv8, v10, v11 models with automatic GPU detection.
    Optimized for NVIDIA T1000 8GB and similar GPUs.
    """

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

    # Fallback model order if primary fails (larger → smaller)
    MODEL_FALLBACKS = ["yolo11s", "yolov10s", "yolov8n"]

    def __init__(
        self,
        model_name: str = "yolo11m",
        confidence: float = 0.5,
        device: str = "auto",
    ):
        self.confidence = confidence

        # Auto-detect device
        if device == "auto":
            if torch.cuda.is_available():
                self.device = "cuda"
                gpu_name = torch.cuda.get_device_name(0)
                gpu_mem = torch.cuda.get_device_properties(0).total_memory / (1024**3)
                log.info("detector.gpu_detected", gpu=gpu_name, vram_gb=f"{gpu_mem:.1f}")
            else:
                self.device = "cpu"
                log.warning("detector.no_gpu", msg="CUDA not available, using CPU")
        else:
            self.device = device

        log.info("detector.loading_model", model=model_name, device=self.device)

        # Try loading model with fallbacks (always load in FP32 first for safe fusing)
        self.model = self._load_model_safe(model_name)
        self.model.to(self.device)

        # FP32 mode — T1000 is fast enough without FP16 and avoids fuse() dtype issues
        self.use_half = False

        # Warm up (multiple passes for GPU to optimize kernels)
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        warmup_passes = 3 if self.device == "cuda" else 1
        for _ in range(warmup_passes):
            self.model.predict(dummy, verbose=False)

        if self.device == "cuda":
            mem_used = torch.cuda.memory_allocated(0) / (1024**2)
            log.info("detector.model_ready", device=self.device, gpu_mem_mb=f"{mem_used:.0f}")
        else:
            log.info("detector.model_ready", device=self.device)

    def _load_model_safe(self, model_name: str) -> YOLO:
        """Load YOLO model with PyTorch 2.6 safe unpickling fallback."""
        models_to_try = [model_name] + [m for m in self.MODEL_FALLBACKS if m != model_name]

        for name in models_to_try:
            try:
                log.info("detector.trying_model", model=name)
                model = YOLO(f"{name}.pt")
                log.info("detector.model_loaded", model=name)
                return model
            except Exception as e:
                error_str = str(e)
                if "Weights only load" in error_str or "UnpicklingError" in error_str:
                    log.warning("detector.pytorch26_compat", model=name, error="weights_only restriction")
                    # Try with weights_only=False via env var (PyTorch 2.6+)
                    try:
                        os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "0"
                        model = YOLO(f"{name}.pt")
                        log.info("detector.model_loaded_unsafe", model=name)
                        return model
                    except Exception as e2:
                        log.warning("detector.fallback_failed", model=name, error=str(e2))
                        continue
                else:
                    log.warning("detector.load_failed", model=name, error=error_str)
                    continue

        raise RuntimeError(f"Could not load any YOLO model. Tried: {models_to_try}")

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Run YOLO inference on a frame. Returns list of detections."""
        start = time.monotonic()

        results = self.model.predict(
            frame,
            conf=self.confidence,
            verbose=False,
            half=False,
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
