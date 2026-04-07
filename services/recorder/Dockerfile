FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir pyyaml asyncpg redis structlog

WORKDIR /app
COPY . /app

CMD ["python3", "recorder.py"]
