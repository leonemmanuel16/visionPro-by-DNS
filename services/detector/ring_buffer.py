"""Ring Buffer — Circular buffer for pre-event video clips.

Stores the last N seconds of compressed frames (JPEG quality 70) per camera.
When a detection event fires, extract pre-event frames + post-event frames
to create a short MP4 clip.

Memory usage: 15s × 5fps = 75 frames × ~30KB JPEG = ~2.2MB per camera
"""

import collections
import io
import os
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import structlog
from minio import Minio

log = structlog.get_logger()


class RingBuffer:
    """Circular frame buffer for one camera."""

    def __init__(self, max_seconds: int = 15, fps: int = 5, jpeg_quality: int = 88):
        self.max_frames = max_seconds * fps
        self.fps = fps
        self.jpeg_quality = jpeg_quality
        self.frames: collections.deque[tuple[bytes, float]] = collections.deque(maxlen=self.max_frames)

    def push(self, frame: np.ndarray) -> None:
        """Add a frame to the ring buffer (compressed as JPEG)."""
        try:
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
            self.frames.append((buf.tobytes(), time.monotonic()))
        except Exception:
            pass  # Don't crash the detection loop for ring buffer issues

    def get_pre_event_frames(self, seconds: int = 15) -> list[np.ndarray]:
        """Get the last N seconds of frames (decoded)."""
        if not self.frames:
            return []

        now = time.monotonic()
        cutoff = now - seconds
        result = []
        for jpeg_bytes, ts in self.frames:
            if ts >= cutoff:
                frame = cv2.imdecode(
                    np.frombuffer(jpeg_bytes, dtype=np.uint8),
                    cv2.IMREAD_COLOR
                )
                if frame is not None:
                    result.append(frame)
        return result

    def get_actual_fps(self) -> float:
        """Calculate actual FPS from frame timestamps (avoids speed-up in clips)."""
        if len(self.frames) < 2:
            return float(self.fps)
        oldest_ts = self.frames[0][1]
        newest_ts = self.frames[-1][1]
        duration = newest_ts - oldest_ts
        if duration <= 0:
            return float(self.fps)
        return len(self.frames) / duration

    def frame_count(self) -> int:
        return len(self.frames)


def create_clip(
    pre_frames: list[np.ndarray],
    post_frames: list[np.ndarray],
    fps: int = 5,
) -> bytes | None:
    """Create an MP4 clip from pre-event + post-event frames.

    Returns MP4 bytes or None on failure.
    """
    all_frames = pre_frames + post_frames
    if len(all_frames) < 3:
        return None

    tmp_raw = None
    tmp_h264 = None
    try:
        h, w = all_frames[0].shape[:2]

        # Step 1: Write raw frames with cv2 (mp4v codec)
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
            tmp_raw = tmp.name

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(tmp_raw, fourcc, fps, (w, h))

        if not writer.isOpened():
            log.warning("ring_buffer.writer_failed", msg="Could not open VideoWriter")
            return None

        for frame in all_frames:
            if frame.shape[:2] != (h, w):
                frame = cv2.resize(frame, (w, h))
            writer.write(frame)

        writer.release()

        # Step 2: Re-encode to H.264 with ffmpeg (browser-compatible)
        import subprocess
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
            tmp_h264 = tmp.name

        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", tmp_raw,
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                tmp_h264,
            ],
            capture_output=True, timeout=60,
        )

        if result.returncode == 0 and Path(tmp_h264).exists():
            clip_bytes = Path(tmp_h264).read_bytes()
        else:
            # Fallback: use raw mp4v (may not play in browser)
            log.warning("ring_buffer.ffmpeg_failed", stderr=result.stderr[-200:] if result.stderr else "")
            clip_bytes = Path(tmp_raw).read_bytes()

        if len(clip_bytes) < 100:
            return None

        log.debug("ring_buffer.clip_created", frames=len(all_frames),
                  duration_s=f"{len(all_frames)/fps:.1f}", size_kb=f"{len(clip_bytes)/1024:.0f}")
        return clip_bytes

    except Exception as e:
        log.warning("ring_buffer.clip_error", error=str(e))
        return None
    finally:
        for p in [tmp_raw, tmp_h264]:
            if p:
                try:
                    os.unlink(p)
                except Exception:
                    pass


async def save_clip_to_minio(
    minio_client: Minio,
    clip_bytes: bytes,
    event_id: str,
    timestamp_str: str,
) -> str | None:
    """Save an MP4 clip to MinIO 'clips' bucket. Returns object path or None."""
    try:
        # Ensure bucket exists
        if not minio_client.bucket_exists("clips"):
            minio_client.make_bucket("clips")

        object_name = f"{timestamp_str}/{event_id}.mp4"
        minio_client.put_object(
            "clips",
            object_name,
            io.BytesIO(clip_bytes),
            len(clip_bytes),
            content_type="video/mp4",
        )
        log.info("ring_buffer.clip_saved", path=f"clips/{object_name}",
                 size_kb=f"{len(clip_bytes)/1024:.0f}")
        return f"clips/{object_name}"
    except Exception as e:
        log.warning("ring_buffer.save_failed", error=str(e))
        return None
