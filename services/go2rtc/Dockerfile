FROM nvidia/cuda:12.4.1-base-ubuntu22.04

# Install FFmpeg with NVENC/NVDEC + go2rtc
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates \
    ffmpeg \
    libnpp-12-4 \
    && rm -rf /var/lib/apt/lists/*

# Download go2rtc binary (latest stable)
ARG GO2RTC_VERSION=1.9.7
RUN wget -q "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64" \
    -O /usr/local/bin/go2rtc && \
    chmod +x /usr/local/bin/go2rtc

# Config directory
RUN mkdir -p /config

EXPOSE 1984 8554 8555

ENTRYPOINT ["go2rtc", "-config", "/config/go2rtc.yaml"]
