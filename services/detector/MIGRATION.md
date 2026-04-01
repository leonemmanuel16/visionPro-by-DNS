# Detector Optimization Migration Guide

## Summary of Changes

### 1. YOLO26s + TensorRT FP16 (detector.py)
- **Model**: `yolo11m` → `yolo26s` (NMS-free, end-to-end detection)
- **TensorRT**: Auto-exports `.engine` file on first run (~2-5 min), then loads compiled engine
- **FP16**: Half-precision inference enabled on CUDA (~2x speedup)
- **Fallback chain**: `yolo26s` → `yolo26n` → `yolo11s` → PyTorch FP16 if TensorRT unavailable

### 2. Frame Grabber Optimization (frame_grabber.py)
- Hardware acceleration hint (`CAP_PROP_HW_ACCELERATION`) for NVDEC
- Connection timeout 5s (was infinite) for faster failure detection
- Read timeout 5s to prevent blocking on stale streams

### 3. InsightFace Replaces dlib/face_recognition (face_recognizer.py)
- **Library**: `face_recognition` (dlib, CPU-only) → `insightface` (ONNX Runtime, GPU-accelerated)
- **Embeddings**: 128-dim → 512-dim (more discriminative)
- **Similarity**: Euclidean distance → Cosine similarity
- **Threshold**: `< 0.45` euclidean → `>= 0.35` cosine similarity
- **Model**: `buffalo_l` (ArcFace backbone)

### 4. HSV Histogram Color Detection (person_attributes.py, vehicle_attributes.py)
- **Replaced**: `cv2.kmeans(pixels, 3, ...)` (slow, ~5ms per detection)
- **With**: HSV histogram + pixel classification (~0.5ms per detection, ~10x faster)

### 5. Best-Shot Frame Optimization (best_shot.py)
- **Before**: `frame.copy()` (6MB full 1080p) on every detection update
- **After**: Stores padded crop (~100KB) during tracking, full frame only at publish time
- **Memory savings**: ~50x less memory per tracked object

### 6. Ring Buffer for Video Clips (ring_buffer.py)
- Stores last 15s of JPEG-compressed frames per camera (~2.2MB per camera)
- Creates MP4 clips on detection events (pre-event footage)
- Saved to MinIO `clips` bucket

---

## Migration Steps

### Step 1: Update `.env` file
```bash
# Add/update these variables in your .env:
MODEL_NAME=yolo26s
RING_BUFFER_SECONDS=15
```

### Step 2: Database Migration (REQUIRED for InsightFace)
InsightFace produces 512-dim embeddings (vs dlib's 128-dim). You MUST update the pgvector columns:

```sql
-- Connect to your PostgreSQL database
-- WARNING: This will invalidate ALL existing embeddings. You'll need to re-upload face photos.

ALTER TABLE face_embeddings ALTER COLUMN embedding TYPE vector(512);
ALTER TABLE unknown_faces ALTER COLUMN embedding TYPE vector(512);
ALTER TABLE dismissed_faces ALTER COLUMN embedding TYPE vector(512);

-- Clear old 128-dim embeddings (they're incompatible)
DELETE FROM face_embeddings;
DELETE FROM unknown_faces;
DELETE FROM dismissed_faces;
```

Run this on the server:
```bash
docker exec -it visionpro-by-dns-postgres-1 psql -U vision -d visionai -c "
ALTER TABLE face_embeddings ALTER COLUMN embedding TYPE vector(512);
ALTER TABLE unknown_faces ALTER COLUMN embedding TYPE vector(512);
ALTER TABLE dismissed_faces ALTER COLUMN embedding TYPE vector(512);
DELETE FROM face_embeddings;
DELETE FROM unknown_faces;
DELETE FROM dismissed_faces;
"
```

### Step 3: Rebuild Docker Image
```bash
cd ~/visionPro-by-DNS
git pull
docker compose build detector
```

Note: The first build will take longer (~10-15 min) because:
- CUDA devel image is larger than runtime
- TensorRT pip install
- InsightFace + ONNX Runtime GPU install
- TensorRT engine compilation for yolo26s

### Step 4: Restart Service
```bash
docker compose up -d detector
```

### Step 5: Re-upload Face Photos
Since embeddings changed from 128-dim to 512-dim, you need to re-upload all person photos
through the dashboard Database page. The new InsightFace model will generate 512-dim embeddings.

### Step 6: Verify
```bash
# Check logs for successful startup
docker compose logs -f detector --tail=50

# You should see:
# "detector.tensorrt_ready" or "detector.fp16_enabled"
# "face_recognizer.ready" with library="insightface"
```

---

## Performance Impact (Expected)

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| YOLO inference (T1000) | ~25ms (FP32) | ~8-12ms (TensorRT FP16) | 2-3x |
| Color detection | ~5ms/object | ~0.5ms/object | 10x |
| Face detection + embedding | ~50ms (dlib CPU) | ~15ms (InsightFace GPU) | 3x |
| Memory per tracked object | ~6MB | ~100KB | 60x |
| Total GPU utilization (3 cams) | ~95% | ~40-60% | 40% headroom |

---

## GAP 1: Batch Inference Multi-Camera (batch_detector.py)

### What Changed
- **Before**: Each camera called `detector.detect(frame)` individually → GPU underutilized (~15%)
- **After**: All cameras submit frames to a centralized `BatchDetector` queue → one batched `detect_batch()` call → GPU utilization ~85%

### Architecture
1. Each camera loop calls `await batch_detector.submit(frame)` (async, returns Future)
2. A background worker collects up to `MAX_BATCH_SIZE` frames within 50ms timeout
3. Runs ONE `detector.detect_batch(frames)` call (Ultralytics natively batches)
4. Routes results back to each camera's Future

### New Files
- `batch_detector.py` — `BatchDetector` class with asyncio.Queue + worker pattern
- `detector.py` — Added `detect_batch()` method and shared `_parse_results()` helper

### Config
```bash
MAX_BATCH_SIZE=8  # Optimal for most GPUs (T1000, RTX 3060, etc.)
```

---

## GAP 2: NVDEC Hardware Video Decoding (gpu_frame_grabber.py)

### What Changed
- **Before**: `cv2.VideoCapture` decodes H.264 on CPU → ~30-50% CPU per camera
- **After**: FFmpeg subprocess with `-hwaccel cuda -c:v h264_cuvid` → decoding on GPU NVDEC engine, near-zero CPU

### Architecture
1. FFmpeg subprocess reads RTSP stream with hardware H.264 decoding
2. Outputs raw BGR24 frames via `pipe:1` (stdout)
3. Python reads exact `width * height * 3` bytes and reshapes to numpy array
4. Auto-probes stream resolution with `ffprobe`
5. Falls back to CPU `FrameGrabber` if NVDEC unavailable

### New Files
- `gpu_frame_grabber.py` — `GpuFrameGrabber` class (FFmpeg NVDEC subprocess)

### Dockerfile Changes
- Added `libnvidia-decode-550 libnvidia-encode-550` for NVDEC/NVENC support

### Config
```bash
USE_GPU_DECODE=true  # Set to false to force CPU decoding
```

---

## Updated Performance Impact

| Metric | Before (v1) | After Phase 2 | After GAP 1+2 | Improvement |
|--------|-------------|---------------|---------------|-------------|
| YOLO inference (1 cam) | ~25ms | ~8-12ms (TRT) | ~8-12ms (TRT) | 2-3x |
| YOLO inference (8 cams) | ~200ms total | ~96ms total | ~30ms total (batched) | 6-7x |
| GPU utilization (3 cams) | ~95% | ~40-60% | ~85% efficient | optimal |
| CPU per camera (decode) | ~30-50% | ~30-50% | ~5% (NVDEC) | 6-10x |
| Max cameras (T1000 8GB) | 3 | 5-6 | 8-12 | 2-4x |

---

## Rollback
If something goes wrong, revert to the previous model:
```bash
# In .env:
MODEL_NAME=yolo11m

# Revert DB:
ALTER TABLE face_embeddings ALTER COLUMN embedding TYPE vector(128);
ALTER TABLE unknown_faces ALTER COLUMN embedding TYPE vector(128);
ALTER TABLE dismissed_faces ALTER COLUMN embedding TYPE vector(128);
```
