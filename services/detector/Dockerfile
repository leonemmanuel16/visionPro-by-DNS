# ============================================================
# DNS Vision Pro — AI Detector (NVIDIA CUDA + YOLO26 + TensorRT)
# Base: NVIDIA CUDA 12.4 devel for TensorRT build + GPU inference
# ============================================================

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Monterrey

# Install Python 3.11 + system deps
# Note: cmake, gcc, g++ needed for onnxruntime-gpu and InsightFace compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev python3-pip \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    ffmpeg tzdata \
    gcc g++ cmake make \
    curl \
    # NVDEC/NVENC — hardware video decode/encode via FFmpeg
    libnvidia-decode-550 libnvidia-encode-550 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel

WORKDIR /app

# Install PyTorch with CUDA 12.4 support first (large download, cached layer)
RUN pip3 install --no-cache-dir \
    torch==2.5.1 torchvision==0.20.1 \
    --index-url https://download.pytorch.org/whl/cu124

# Install TensorRT (for optimized inference engine)
RUN pip3 install --no-cache-dir tensorrt || true

# Install remaining dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

# Pre-download YOLO models
# yolo11s-p2: P2 head for small object detection (faces, plates in CCTV)
# yolo26s: fallback if p2 variant unavailable
# TensorRT engine built at first GPU run (~3-5 min, cached in volume)
RUN python3 -c "\
from ultralytics import YOLO; \
print('Downloading yolo11s-p2 (P2 small-object head)...'); \
m = YOLO('yolo11s-p2.pt'); \
print('yolo11s-p2.pt downloaded successfully'); \
print('Downloading yolo26s (fallback)...'); \
m2 = YOLO('yolo26s.pt'); \
print('yolo26s.pt downloaded successfully'); \
" || echo "Model download failed (will retry at runtime)"

CMD ["python3", "main.py"]
