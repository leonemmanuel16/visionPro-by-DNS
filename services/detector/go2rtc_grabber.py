"""Go2RTC Frame Grabber — Fetches JPEG snapshots from go2rtc HTTP API.

Replaces 18 direct RTSP connections to the NVR.  go2rtc already maintains
the sub-stream connections, so we just request JPEG frames via HTTP.

Benefits over direct RTSP:
  - 0 extra RTSP connections (go2rtc already has them)
  - 0 H.265 decoding in the detector (go2rtc decodes)
  - Frames arrive pre-decoded as JPEG — just imdecode to numpy
  - Parallel HTTP fetch of all 18 cameras in ~30-50ms on localhost
"""

import asyncio

import cv2
import httpx
import numpy as np
import structlog

log = structlog.get_logger()


class Go2rtcGrabber:
    """Fetches JPEG frames from go2rtc for all cameras in parallel."""

    def __init__(self, go2rtc_url: str = "http://localhost:1984", width: int = 640):
        self.go2rtc_url = go2rtc_url.rstrip("/")
        self.width = width
        self._client: httpx.AsyncClient | None = None

    async def start(self):
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=3.0),
            limits=httpx.Limits(max_connections=30, max_keepalive_connections=20),
        )
        log.info("go2rtc_grabber.started", url=self.go2rtc_url, width=self.width)

    async def stop(self):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def fetch_frame(self, stream_name: str) -> np.ndarray | None:
        """Fetch a single JPEG frame from go2rtc and decode to BGR numpy array."""
        try:
            url = f"{self.go2rtc_url}/api/frame.jpeg?src={stream_name}&width={self.width}"
            resp = await self._client.get(url)
            if resp.status_code != 200:
                return None
            buf = np.frombuffer(resp.content, dtype=np.uint8)
            frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            return frame
        except Exception as e:
            log.debug("go2rtc_grabber.fetch_error", stream=stream_name, error=str(e))
            return None

    async def fetch_all(self, cameras: dict[str, str]) -> dict[str, np.ndarray]:
        """Fetch frames from all cameras in parallel.

        Args:
            cameras: dict mapping camera_id -> go2rtc stream name
                     e.g. {"uuid-1": "cam_abc123def456_sub", ...}

        Returns:
            dict of camera_id -> BGR numpy array (only successful fetches)
        """
        if not cameras:
            return {}

        cam_ids = list(cameras.keys())
        stream_names = [cameras[cid] for cid in cam_ids]

        results = await asyncio.gather(
            *(self.fetch_frame(name) for name in stream_names),
            return_exceptions=True,
        )

        frames: dict[str, np.ndarray] = {}
        for cam_id, result in zip(cam_ids, results):
            if isinstance(result, np.ndarray) and result is not None:
                frames[cam_id] = result

        return frames
