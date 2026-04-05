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
    ffmpeg \
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

# Pre-download YOLO26n model and export TensorRT engine with dynamic batch
# This takes 2-5 minutes but makes container startup instant
# Dynamic batch (1-16) enables true GPU-batched inference across cameras
RUN python3 -c "\
from ultralytics import YOLO; \
import torch; \
print('Downloading yolo26n...'); \
m = YOLO('yolo26n.pt'); \
if torch.cuda.is_available(): \
    print('Exporting TensorRT engine with dynamic batch=16, FP16...'); \
    m.export(format='engine', half=True, batch=16, dynamic=True); \
    print('TensorRT dynamic batch engine built successfully'); \
else: \
    print('No GPU at build time, TensorRT engine will be built at first run'); \
" || echo "Model pre-build failed (will retry at runtime)"

CMD ["python3", "main.py"]
