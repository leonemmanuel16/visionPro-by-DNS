"""Frame Grabber - Pull frames from go2rtc RTSP streams.

Optimizations:
- Hardware acceleration hint (CAP_PROP_HW_ACCELERATION)
- Connection timeout (5s) for faster failure detection
- Buffer size 1 for lowest latency
"""

import time

import cv2
import numpy as np
import structlog
import torch

log = structlog.get_logger()


class FrameGrabber:
    """Grabs frames from an RTSP stream via OpenCV."""

    def __init__(self, stream_url: str, target_fps: int = 5, go2rtc_url: str = "",
                 use_cuda: bool = False):
        self.stream_url = stream_url
        self.target_fps = target_fps
        self.frame_interval = 1.0 / target_fps
        self.cap: cv2.VideoCapture | None = None
        self.last_grab_time = 0.0
        self.reconnect_delay = 1.0
        self.max_reconnect_delay = 30.0
        self.use_cuda = use_cuda and torch.cuda.is_available()

    def _connect(self) -> bool:
        """Connect to the RTSP stream."""
        try:
            if self.cap is not None:
                self.cap.release()

            self.cap = cv2.VideoCapture(self.stream_url, cv2.CAP_FFMPEG)

            # Optimize for low latency
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            # Connection timeout — fail fast instead of hanging
            self.cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
            self.cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)

            # Try hardware acceleration (NVDEC/VAAPI/etc.)
            if self.use_cuda:
                try:
                    self.cap.set(cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_ANY)
                    log.info("frame_grabber.hw_accel_requested")
                except Exception:
                    pass  # Not all OpenCV builds support this

            if self.cap.isOpened():
                self.reconnect_delay = 1.0  # Reset backoff
                log.info("frame_grabber.connected", url=self.stream_url[:50],
                         hw_accel=self.use_cuda)
                return True
            else:
                log.warning("frame_grabber.connect_failed", url=self.stream_url[:50])
                return False
        except Exception as e:
            log.error("frame_grabber.connect_error", error=str(e))
            return False

    def grab_frame(self) -> np.ndarray | None:
        """Grab a single frame, respecting FPS limits.

        Returns numpy array (BGR) or None if no frame available.
        This is a blocking call meant to run in a thread pool.
        """
        # Rate limit
        now = time.monotonic()
        elapsed = now - self.last_grab_time
        if elapsed < self.frame_interval:
            time.sleep(self.frame_interval - elapsed)

        # Connect if needed
        if self.cap is None or not self.cap.isOpened():
            if not self._connect():
                time.sleep(self.reconnect_delay)
                self.reconnect_delay = min(
                    self.reconnect_delay * 2, self.max_reconnect_delay
                )
                return None

        try:
            ret, frame = self.cap.read()
            if not ret or frame is None:
                log.warning("frame_grabber.read_failed")
                self.cap.release()
                self.cap = None
                return None

            self.last_grab_time = time.monotonic()
            return frame
        except Exception as e:
            log.error("frame_grabber.grab_error", error=str(e))
            self.cap = None
            return None

    def release(self):
        """Release the video capture."""
        if self.cap is not None:
            self.cap.release()
            self.cap = None
