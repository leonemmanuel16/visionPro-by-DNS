"""Go2RTC Frame Grabber — Background threads fetch JPEG snapshots continuously.

Each camera gets its own thread that loops fetching frames from go2rtc.
The mosaic loop reads the latest cached frame instantly (no network wait).

This solves the 1.9s fetch bottleneck: go2rtc's frame.jpeg waits for the
next keyframe (~100-500ms per request), but with background threads each
camera fetches independently and the detection loop is never blocked.
"""

import threading
import time
from urllib.request import urlopen, Request

import cv2
import numpy as np
import structlog

log = structlog.get_logger()


class Go2rtcGrabber:
    """Fetches JPEG frames from go2rtc using background threads per camera."""

    def __init__(self, go2rtc_url: str = "http://localhost:1984", width: int = 640):
        self.go2rtc_url = go2rtc_url.rstrip("/")
        self.width = width
        self._running = False
        self._threads: dict[str, threading.Thread] = {}
        self._latest: dict[str, np.ndarray] = {}  # cam_id -> latest frame
        self._lock = threading.Lock()

    async def start(self):
        self._running = True
        log.info("go2rtc_grabber.started", url=self.go2rtc_url, width=self.width)

    async def stop(self):
        self._running = False
        for t in self._threads.values():
            t.join(timeout=3)
        self._threads.clear()
        self._latest.clear()

    def start_camera(self, cam_id: str, stream_name: str):
        """Start a background fetch thread for a camera."""
        if cam_id in self._threads and self._threads[cam_id].is_alive():
            return
        t = threading.Thread(
            target=self._fetch_loop,
            args=(cam_id, stream_name),
            daemon=True,
            name=f"grab-{cam_id[:8]}",
        )
        t.start()
        self._threads[cam_id] = t

    def stop_camera(self, cam_id: str):
        """Stop the background thread for a camera."""
        self._threads.pop(cam_id, None)
        with self._lock:
            self._latest.pop(cam_id, None)

    def _fetch_loop(self, cam_id: str, stream_name: str):
        """Background thread: continuously fetch JPEG frames from go2rtc."""
        url = f"{self.go2rtc_url}/api/frame.jpeg?src={stream_name}&width={self.width}"
        fails = 0
        while self._running and cam_id in self._threads:
            try:
                req = Request(url)
                resp = urlopen(req, timeout=3)
                data = resp.read()
                buf = np.frombuffer(data, dtype=np.uint8)
                frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
                if frame is not None:
                    with self._lock:
                        self._latest[cam_id] = frame
                    fails = 0
                else:
                    fails += 1
            except Exception:
                fails += 1
                if fails <= 3:
                    time.sleep(0.5)
                else:
                    time.sleep(2)  # backoff on repeated failures
                continue

    def fetch_hires_frame(self, stream_name: str) -> np.ndarray | None:
        """Fetch a single full-resolution frame on demand (blocking).

        Used for 4MP alert snapshots — called from thread pool executor.
        go2rtc auto-connects to the main stream if not already active.
        No width parameter = native resolution (4MP).
        """
        url = f"{self.go2rtc_url}/api/frame.jpeg?src={stream_name}"
        try:
            resp = urlopen(Request(url), timeout=8)
            data = resp.read()
            buf = np.frombuffer(data, dtype=np.uint8)
            frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if frame is not None:
                h, w = frame.shape[:2]
                log.info("go2rtc_grabber.hires_frame", stream=stream_name,
                         resolution=f"{w}x{h}")
            return frame
        except Exception as e:
            log.warning("go2rtc_grabber.hires_error", stream=stream_name, error=str(e))
            return None

    async def fetch_all(self, cameras: dict[str, str]) -> dict[str, np.ndarray]:
        """Return latest cached frames for all cameras (instant, no network wait).

        Also starts background threads for any new cameras.

        Args:
            cameras: dict mapping camera_id -> go2rtc stream name

        Returns:
            dict of camera_id -> BGR numpy array
        """
        # Start threads for new cameras
        for cam_id, stream_name in cameras.items():
            if cam_id not in self._threads or not self._threads[cam_id].is_alive():
                self.start_camera(cam_id, stream_name)

        # Stop threads for removed cameras
        removed = [cid for cid in self._threads if cid not in cameras]
        for cid in removed:
            self.stop_camera(cid)

        # Return latest frames (instant copy)
        with self._lock:
            return {cid: frame for cid, frame in self._latest.items() if cid in cameras}
