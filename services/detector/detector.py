"""YOLO Detection Wrapper — YOLO26s + TensorRT FP16 (Dynamic Batch).

YOLO26 is NMS-free (end-to-end), giving lower latency.
TensorRT export compiles the model with dynamic batch (1-16) for GPU-efficient batching.
FP16 half-precision gives ~2x speedup on NVIDIA GPUs with minimal accuracy loss.
"""

import os
import time
from dataclasses import dataclass
from pathlib import Path

import shutil
import numpy as np
import structlog
import torch
from ultralytics import YOLO

# Persistent model directory (Docker volume mounted)
MODELS_DIR = Path("/app/models")
MODELS_DIR.mkdir(exist_ok=True)

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
    MODEL_FALLBACKS = ["yolo11s", "yolo11n", "yolo26s"]

    # Max batch size for TensorRT dynamic batching
    ENGINE_MAX_BATCH = 16

    def __init__(
        self,
        model_name: str = "yolo11s",
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

        # Try loading model: TensorRT engine > PyTorch FP32
        self.model = self._load_model(model_name)

        # FP16 only with TensorRT engines (T1000 lacks tensor cores, PyTorch FP16 produces NaN)
        self.use_half = self._using_engine

        # Warm up at both resolutions (640 for 3x3 mosaics, 960 for 2x2 mosaics)
        warmup_passes = 3 if self.device == "cuda" else 1
        for size in [640, 960]:
            dummy = np.zeros((size, size, 3), dtype=np.uint8)
            for _ in range(warmup_passes):
                self.model.predict(dummy, verbose=False, half=self.use_half,
                                   device=self.device, imgsz=size)

        if self.device == "cuda":
            mem_used = torch.cuda.memory_allocated(0) / (1024**2)
            gpu_total = torch.cuda.get_device_properties(0).total_memory / (1024**2)
            log.info("detector.model_ready",
                     model=model_name,
                     device=self.device,
                     gpu_mem_used_mb=f"{mem_used:.0f}",
                     gpu_mem_total_mb=f"{gpu_total:.0f}",
                     half=self.use_half,
                     engine=self._using_engine,
                     dynamic_batch=self._engine_dynamic)
        else:
            log.info("detector.model_ready", model=model_name, device=self.device)

    def _load_model(self, model_name: str) -> YOLO:
        """Load model: try TensorRT engine first, then PyTorch .pt with FP16."""
        self._using_engine = False
        self._engine_dynamic = False
        models_to_try = [model_name] + [m for m in self.MODEL_FALLBACKS if m != model_name]

        skip_trt = os.environ.get("SKIP_TENSORRT", "").lower() in ("1", "true", "yes")
        if skip_trt:
            log.info("detector.tensorrt_skipped", msg="SKIP_TENSORRT is set, using PyTorch directly")

        for name in models_to_try:
            # 1. Try pre-built TensorRT engine (skip if SKIP_TENSORRT is set)
            if self.device == "cuda" and not skip_trt:
                for engine_path in [MODELS_DIR / f"{name}.engine", Path(f"{name}.engine")]:
                    if engine_path.exists():
                        try:
                            log.info("detector.loading_engine", model=name, path=str(engine_path))
                            model = YOLO(str(engine_path))
                            self._using_engine = True
                            self._engine_dynamic = True
                            log.info("detector.engine_loaded", model=name,
                                     path=str(engine_path), dynamic_batch=True)
                            return model
                        except Exception as e:
                            log.warning("detector.engine_load_failed", model=name, error=str(e))

            # 2. Try loading .pt and optionally exporting to TensorRT
            pt_model = self._load_pt_safe(name)
            if pt_model is None:
                continue

            if self.device == "cuda" and not skip_trt:
                engine_model = self._try_export_tensorrt(pt_model, name)
                if engine_model is not None:
                    return engine_model

            # 3. Use PyTorch FP32 on GPU (or CPU fallback)
            log.info("detector.using_pytorch", model=name, device=self.device)
            pt_model.to(self.device)
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
        """Try to export model to TensorRT engine with dynamic batching.

        Dynamic batch allows the same engine to process 1-16 frames at once,
        enabling true GPU-batched inference across multiple cameras.
        """
        try:
            log.info("detector.exporting_tensorrt", model=model_name,
                     batch=self.ENGINE_MAX_BATCH,
                     msg="This may take 2-5 minutes on first run...")
            engine_path = model.export(
                format="engine",
                half=True,
                device=0,
                imgsz=960,   # Export at max resolution (supports 640 and 960 inputs)
                batch=self.ENGINE_MAX_BATCH,
                dynamic=True,
            )
            if engine_path and Path(engine_path).exists():
                # Copy engine to persistent volume so it survives container restarts
                persistent_path = MODELS_DIR / f"{model_name}.engine"
                try:
                    shutil.copy2(engine_path, persistent_path)
                    log.info("detector.engine_persisted", path=str(persistent_path))
                except Exception as e:
                    log.warning("detector.engine_persist_failed", error=str(e))
                engine_model = YOLO(engine_path)
                self._using_engine = True
                self._engine_dynamic = True
                log.info("detector.tensorrt_ready", model=model_name,
                         engine=engine_path, dynamic_batch=True,
                         max_batch=self.ENGINE_MAX_BATCH)
                return engine_model
        except Exception as e:
            log.warning("detector.tensorrt_dynamic_failed", model=model_name,
                        error=str(e), msg="Trying static batch=1 fallback...")
            # Fallback: static batch=1 engine
            try:
                engine_path = model.export(format="engine", half=True, device=0)
                if engine_path and Path(engine_path).exists():
                    persistent_path = MODELS_DIR / f"{model_name}.engine"
                    try:
                        shutil.copy2(engine_path, persistent_path)
                    except Exception:
                        pass
                    engine_model = YOLO(engine_path)
                    self._using_engine = True
                    self._engine_dynamic = False
                    log.info("detector.tensorrt_ready", model=model_name,
                             engine=engine_path, dynamic_batch=False)
                    return engine_model
            except Exception as e2:
                log.warning("detector.tensorrt_export_failed", model=model_name,
                            error=str(e2), msg="Falling back to PyTorch FP16")
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

        input_size = frame.shape[0] if frame.shape[0] in (640, 960) else 640
        results = self.model.predict(
            frame,
            conf=self.confidence,
            verbose=False,
            half=self.use_half,
            device=self.device,
            imgsz=input_size,
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

        With dynamic TensorRT engine: TRUE batched GPU inference (1 call for all frames).
        With static engine (batch=1): sequential processing (fallback).
        With PyTorch: native batched inference.

        imgsz is set to match the input frame size (960 for 2x2 mosaics, 640 for 3x3)
        so YOLO uses the full resolution instead of downscaling to its default 640.
        """
        if not frames:
            return []

        start = time.monotonic()

        # Use the actual input size so YOLO doesn't downscale (960 for 2x2, 640 for 3x3)
        input_size = frames[0].shape[0]  # mosaic is always square
        imgsz = input_size if input_size in (640, 960) else 640

        if self._using_engine and not self._engine_dynamic:
            # Static TensorRT engine (batch=1) — must iterate
            batch_detections = []
            for frame in frames:
                results = self.model.predict(
                    frame,
                    conf=self.confidence,
                    verbose=False,
                    half=self.use_half,
                    device=self.device,
                    imgsz=imgsz,
                    classes=list(self.TARGET_CLASSES.keys()),
                )
                batch_detections.extend(self._parse_results(results))
        else:
            # Dynamic TensorRT engine OR PyTorch — true batched inference
            # Process in chunks of ENGINE_MAX_BATCH to respect engine limits
            batch_detections = []
            chunk_size = self.ENGINE_MAX_BATCH if self._using_engine else len(frames)
            for i in range(0, len(frames), chunk_size):
                chunk = frames[i:i + chunk_size]
                try:
                    results = self.model.predict(
                        chunk,
                        conf=self.confidence,
                        verbose=False,
                        half=self.use_half,
                        device=self.device,
                        imgsz=imgsz,
                        classes=list(self.TARGET_CLASSES.keys()),
                    )
                    batch_detections.extend(self._parse_results(results))
                except Exception as e:
                    # If batched inference fails (engine mismatch), fall back to sequential
                    if self._using_engine and self._engine_dynamic:
                        log.warning("detector.batch_fallback", error=str(e),
                                    msg="Dynamic batch failed, falling back to sequential")
                        self._engine_dynamic = False
                        for frame in chunk:
                            results = self.model.predict(
                                frame,
                                conf=self.confidence,
                                verbose=False,
                                half=self.use_half,
                                device=self.device,
                                imgsz=imgsz,
                                classes=list(self.TARGET_CLASSES.keys()),
                            )
                            batch_detections.extend(self._parse_results(results))
                    else:
                        raise

        elapsed = (time.monotonic() - start) * 1000
        total_dets = sum(len(d) for d in batch_detections)
        log.debug("detector.batch_inference", batch_size=len(frames),
                  total_detections=total_dets, ms=f"{elapsed:.1f}",
                  ms_per_frame=f"{elapsed / len(frames):.1f}",
                  imgsz=imgsz,
                  engine=self._using_engine,
                  dynamic=self._engine_dynamic)

        return batch_detections
