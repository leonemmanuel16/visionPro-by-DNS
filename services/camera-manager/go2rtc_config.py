"""go2rtc Config Manager - Auto-generate streaming configuration."""

import os
import asyncpg
import httpx
import structlog
import yaml

log = structlog.get_logger()

# Use NVENC hardware encoding if available (NVIDIA GPU)
# Set GO2RTC_HWACCEL=false to force software encoding
USE_NVENC = os.environ.get("GO2RTC_HWACCEL", "true").lower() in ("true", "1", "yes")


class Go2RTCConfigManager:
    """Generates go2rtc.yaml from database camera records.

    For each camera, generates:
      - cam_<id12>         : Raw RTSP (H.265/H.264 as-is, for recording/detector)
      - cam_<id12>_h264    : Transcoded to H.264 via FFmpeg NVENC (browser-compatible)
      - cam_<id12>_sub     : Raw sub-stream RTSP
      - cam_<id12>_sub_h264: Transcoded sub-stream to H.264 via FFmpeg NVENC
    """

    def __init__(self, db_pool: asyncpg.Pool, config_path: str = "/config/go2rtc.yaml"):
        self.db = db_pool
        self.config_path = config_path
        # camera-manager runs with network_mode: host, so localhost reaches go2rtc
        self.go2rtc_api = "http://localhost:1984"

    async def regenerate(self) -> None:
        """Rebuild go2rtc.yaml from all enabled cameras and reload."""
        try:
            async with self.db.acquire() as conn:
                cameras = await conn.fetch(
                    """SELECT id, name, ip_address, rtsp_main_stream, rtsp_sub_stream
                       FROM cameras WHERE is_enabled = true AND rtsp_main_stream IS NOT NULL"""
                )
        except Exception as e:
            log.error("go2rtc_config.db_error", error=str(e))
            return

        log.info("go2rtc_config.cameras_found", count=len(cameras))

        # Choose encoder: NVENC (GPU) or libx264 (CPU)
        video_codec = "h264" if not USE_NVENC else "h264"
        # go2rtc FFmpeg input flags for NVIDIA hardware decoding
        hw_input = "-hwaccel cuda -hwaccel_output_format cuda" if USE_NVENC else ""
        # go2rtc FFmpeg output flags for NVIDIA hardware encoding
        hw_output = "-c:v h264_nvenc -preset p4 -tune ll -b:v 2M" if USE_NVENC else ""

        log.info("go2rtc_config.codec", nvenc=USE_NVENC, hw_input=hw_input, hw_output=hw_output)

        streams: dict[str, list[str]] = {}
        for cam in cameras:
            # Use short ID for stream name
            cam_id = str(cam["id"]).replace("-", "")[:12]
            safe_name = f"cam_{cam_id}"

            # --- Main stream ---
            if cam["rtsp_main_stream"]:
                rtsp_main = cam["rtsp_main_stream"]

                # Base stream: raw RTSP (for detector/recording)
                streams[safe_name] = [rtsp_main]

                # H.264 transcoded stream: browser-compatible WebRTC/HLS
                if USE_NVENC:
                    # NVIDIA hardware: decode with NVDEC, encode with NVENC
                    streams[f"{safe_name}_h264"] = [
                        f"ffmpeg:{safe_name}#input={hw_input}#raw=-c:v h264_nvenc -preset p4 -tune ll -b:v 2M -c:a libopus"
                    ]
                else:
                    # Software fallback
                    streams[f"{safe_name}_h264"] = [
                        f"ffmpeg:{safe_name}#video=h264#audio=opus"
                    ]

            # --- Sub stream ---
            if cam["rtsp_sub_stream"] and cam["rtsp_sub_stream"] != cam["rtsp_main_stream"]:
                rtsp_sub = cam["rtsp_sub_stream"]

                # Base sub-stream: raw RTSP
                streams[f"{safe_name}_sub"] = [rtsp_sub]

                # H.264 transcoded sub-stream
                if USE_NVENC:
                    streams[f"{safe_name}_sub_h264"] = [
                        f"ffmpeg:{safe_name}_sub#input={hw_input}#raw=-c:v h264_nvenc -preset p4 -tune ll -b:v 1M -c:a libopus"
                    ]
                else:
                    streams[f"{safe_name}_sub_h264"] = [
                        f"ffmpeg:{safe_name}_sub#video=h264#audio=opus"
                    ]


        config = {
            "api": {"listen": ":1984"},
            "webrtc": {"listen": ":8555"},
            "streams": streams,
        }

        # Write config file
        try:
            with open(self.config_path, "w") as f:
                yaml.dump(config, f, default_flow_style=False)
            log.info("go2rtc_config.written", path=self.config_path, streams=len(streams))
        except OSError as e:
            log.error("go2rtc_config.write_failed", path=self.config_path, error=str(e))
            return

        # Signal go2rtc to reload config via API
        await self._reload_go2rtc()

    async def _reload_go2rtc(self) -> None:
        """Signal go2rtc to reload its configuration.

        go2rtc supports adding streams via PUT /api/streams.
        We re-add each stream from the config to ensure go2rtc picks up changes.
        GET /api/config is read-only and doesn't trigger a reload.
        """
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # Read the config we just wrote
                with open(self.config_path) as f:
                    config = yaml.safe_load(f)

                streams = config.get("streams", {})

                # Add each stream via go2rtc API
                for name, sources in streams.items():
                    if isinstance(sources, list) and sources:
                        payload = {"name": name, "src": sources[0]}
                        try:
                            resp = await client.put(
                                f"{self.go2rtc_api}/api/streams",
                                params=payload,
                            )
                            if resp.status_code in (200, 201):
                                log.debug("go2rtc_config.stream_added", name=name)
                            else:
                                log.warning("go2rtc_config.stream_add_failed",
                                            name=name, status=resp.status_code)
                        except Exception as e:
                            log.warning("go2rtc_config.stream_add_error",
                                        name=name, error=str(e))

                log.info("go2rtc_config.reload_complete", streams=len(streams))
        except httpx.ConnectError:
            log.warning("go2rtc_config.not_reachable", url=self.go2rtc_api)
        except Exception as e:
            log.warning("go2rtc_config.reload_failed", error=str(e))
