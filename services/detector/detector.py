"""YOLO Detection Wrapper — YOLO26s + TensorRT FP16.

YOLO26 is NMS-free (end-to-end), giving lower latency.
TensorRT export compiles the model into an optimized engine for the specific GPU.
FP16 half-precision gives ~2x speedup on NVIDIA GPUs with minimal accuracy loss.
"""

import os
import time
from dataclasses import dataclass
from pathlib import Path

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

    Supports YOLO26, v11, v10, v8 models with automatic GPU detection.
    Attempts TensorRT export for maximum performance, falls back to PyTorch FP16.
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

    # Fallback model order if primary fails (larger -> smaller)
    MODEL_FALLBACKS = ["yolo26s", "yolo26n", "yolo11s"]

    def __init__(
        self,
        model_name: str = "yolo26s",
        confidence: float = 0.5,
        device: str = "auto",
    ):
        self.confidence = confidence
        self.model_name = model_name

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

        # FP16 on CUDA — ~2x speedup on T1000 and similar GPUs
        self.use_half = self.device == "cuda"

        # Try loading model: TensorRT engine > PyTorch .pt with FP16
        self.model = self._load_model(model_name)

        # Warm up (multiple passes for GPU to optimize kernels)
        dummy = np.zeros((640, 640, 3), dtype=np.uint8)
        warmup_passes = 3 if self.device == "cuda" else 1
        for _ in range(warmup_passes):
            self.model.predict(dummy, verbose=False, half=self.use_half)

        if self.device == "cuda":
            mem_used = torch.cuda.memory_allocated(0) / (1024**2)
            log.info("detector.model_ready", device=self.device, gpu_mem_mb=f"{mem_used:.0f}",
                     half=self.use_half, engine=self._using_engine)
        else:
            log.info("detector.model_ready", device=self.device)

    def _load_model(self, model_name: str) -> YOLO:
        """Load model: try TensorRT engine first, then PyTorch .pt with FP16."""
        self._using_engine = False
        models_to_try = [model_name] + [m for m in self.MODEL_FALLBACKS if m != model_name]

        for name in models_to_try:
            # 1. Try pre-built TensorRT engine
            if self.device == "cuda":
                engine_path = Path(f"{name}.engine")
                if engine_path.exists():
                    try:
                        log.info("detector.loading_engine", model=name)
                        model = YOLO(str(engine_path))
                        self._using_engine = True
                        log.info("detector.engine_loaded", model=name)
                        return model
                    except Exception as e:
                        log.warning("detector.engine_load_failed", model=name, error=str(e))

            # 2. Try loading .pt and exporting to TensorRT
            pt_model = self._load_pt_safe(name)
            if pt_model is None:
                continue

            if self.device == "cuda":
                engine_model = self._try_export_tensorrt(pt_model, name)
                if engine_model is not None:
                    return engine_model

                # 3. Fallback: use PyTorch .pt with FP16
                log.info("detector.using_pytorch_fp16", model=name)
                pt_model.to(self.device)
                if self.use_half:
                    try:
                        pt_model.model.half()
                        log.info("detector.fp16_enabled", model=name)
                    except Exception as e:
                        log.warning("detector.fp16_failed", error=str(e))
                        self.use_half = False
                return pt_model
            else:
                return pt_model

        raise RuntimeError(f"Could not load any YOLO model. Tried: {models_to_try}")

    def _load_pt_safe(self, model_name: str) -> YOLO | None:
        """Load YOLO .pt model with PyTorch 2.6 safe unpickling fallback."""
        try:
            log.info("detector.trying_model", model=model_name)
            model = YOLO(f"{model_name}.pt")
            log.info("detector.model_loaded", model=model_name)
            return model
        except Exception as e:
            error_str = str(e)
            if "Weights only load" in error_str or "UnpicklingError" in error_str:
                log.warning("detector.pytorch26_compat", model=model_name)
                try:
                    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "0"
                    model = YOLO(f"{model_name}.pt")
                    log.info("detector.model_loaded_unsafe", model=model_name)
                    return model
                except Exception as e2:
                    log.warning("detector.fallback_failed", model=model_name, error=str(e2))
            else:
                log.warning("detector.load_failed", model=model_name, error=error_str)
            return None

    def _try_export_tensorrt(self, model: YOLO, model_name: str) -> YOLO | None:
        """Try to export model to TensorRT engine. Returns loaded engine or None."""
        try:
            log.info("detector.exporting_tensorrt", model=model_name,
                     msg="This may take 2-5 minutes on first run...")
            engine_path = model.export(format="engine", half=True, device=0)
            if engine_path and Path(engine_path).exists():
                engine_model = YOLO(engine_path)
                self._using_engine = True
                log.info("detector.tensorrt_ready", model=model_name, engine=engine_path)
                return engine_model
        except Exception as e:
            log.warning("detector.tensorrt_export_failed", model=model_name, error=str(e),
                        msg="Falling back to PyTorch FP16")
        return None

    def _parse_results(self, results) -> list[list[Detection]]:
        """Parse YOLO results into lists of Detection objects."""
        batch_detections = []
        for result in results:
            detections = []
            if result.boxes is not None:
                boxes = result.boxes
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
            batch_detections.append(detections)
        return batch_detections

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Run YOLO inference on a single frame. Returns list of detections."""
        start = time.monotonic()

        results = self.model.predict(
            frame,
            conf=self.confidence,
            verbose=False,
            half=self.use_half,
            classes=list(self.TARGET_CLASSES.keys()),
        )

        detections = self._parse_results(results)[0] if results else []

        elapsed = (time.monotonic() - start) * 1000
        if detections:
            log.debug("detector.inference", count=len(detections), ms=f"{elapsed:.1f}")
        else:
            log.debug("detector.no_detections", ms=f"{elapsed:.1f}")

        return detections

    def detect_batch(self, frames: list[np.ndarray]) -> list[list[Detection]]:
        """Run YOLO inference on a batch of frames. Returns list of detection lists.

        Ultralytics YOLO natively accepts a list of images and processes them
        as a single batched tensor — much more GPU-efficient than individual calls.
        """
        if not frames:
            return []

        start = time.monotonic()

        # Ultralytics YOLO accepts a list of frames natively
        results = self.model.predict(
            frames,
            conf=self.confidence,
            verbose=False,
            half=self.use_half,
            classes=list(self.TARGET_CLASSES.keys()),
        )

        batch_detections = self._parse_results(results)

        elapsed = (time.monotonic() - start) * 1000
        total_dets = sum(len(d) for d in batch_detections)
        log.debug("detector.batch_inference", batch_size=len(frames),
                  total_detections=total_dets, ms=f"{elapsed:.1f}",
                  ms_per_frame=f"{elapsed / len(frames):.1f}")

        return batch_detections
