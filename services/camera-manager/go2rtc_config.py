"""go2rtc Config Manager - Auto-generate streaming configuration."""

import asyncpg
import httpx
import structlog
import yaml

log = structlog.get_logger()


class Go2RTCConfigManager:
    """Generates go2rtc.yaml from database camera records.

    For each camera, generates:
      - cam_<id12>         : Raw RTSP (H.265/H.264 as-is, for recording/detector)
      - cam_<id12>_h264    : Transcoded to H.264/Opus via FFmpeg (browser-compatible)
      - cam_<id12>_sub     : Raw sub-stream RTSP
      - cam_<id12>_sub_h264: Transcoded sub-stream to H.264/Opus
    """

    def __init__(self, db_pool: asyncpg.Pool, config_path: str = "/config/go2rtc.yaml"):
        self.db = db_pool
        self.config_path = config_path
        # camera-manager runs with network_mode: host, so localhost reaches go2rtc
        self.go2rtc_api = "http://localhost:1984"

    async def regenerate(self) -> None:
        """Rebuild go2rtc.yaml from all enabled cameras and reload."""
        async with self.db.acquire() as conn:
            cameras = await conn.fetch(
                """SELECT id, name, ip_address, rtsp_main_stream, rtsp_sub_stream, camera_type
                   FROM cameras WHERE is_enabled = true AND rtsp_main_stream IS NOT NULL"""
            )

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
                # go2rtc ffmpeg syntax: reference the base stream and transcode
                streams[f"{safe_name}_h264"] = [
                    f"ffmpeg:{safe_name}#video=h264#audio=opus"
                ]

            # --- Sub stream ---
            if cam["rtsp_sub_stream"] and cam["rtsp_sub_stream"] != cam["rtsp_main_stream"]:
                rtsp_sub = cam["rtsp_sub_stream"]

                # Base sub-stream: raw RTSP
                streams[f"{safe_name}_sub"] = [rtsp_sub]

                # H.264 transcoded sub-stream
                streams[f"{safe_name}_sub_h264"] = [
                    f"ffmpeg:{safe_name}_sub#video=h264#audio=opus"
                ]

            # --- Fisheye dewarped quadrants ---
            # If camera is fisheye, generate 4 dewarped flat views using FFmpeg v360 filter
            camera_type = cam.get("camera_type", "") or ""
            if camera_type.lower() in ("fisheye", "ojo de pez", "ojodepez"):
                # 4 quadrants at yaw 0°, 90°, 180°, 270° with 90° FOV each
                for qi, yaw in enumerate([0, 90, 180, 270]):
                    # FFmpeg filter: fisheye→flat (rectilinear) projection
                    # h_fov/v_fov=90: 90° field of view per quadrant
                    # yaw: rotation angle for each quadrant
                    vf = f"v360=fisheye:flat:h_fov=90:v_fov=90:yaw={yaw}"
                    streams[f"{safe_name}_dw{qi}"] = [
                        f"ffmpeg:{safe_name}#video=h264#hardware#raw_filter={vf}"
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
