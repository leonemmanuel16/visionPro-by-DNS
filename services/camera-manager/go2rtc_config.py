"""go2rtc Config Manager - Auto-generate streaming configuration."""

import asyncpg
import httpx
import structlog
import yaml

log = structlog.get_logger()


class Go2RTCConfigManager:
    """Generates go2rtc.yaml from database camera records."""

    def __init__(self, db_pool: asyncpg.Pool, config_path: str = "/config/go2rtc.yaml"):
        self.db = db_pool
        self.config_path = config_path
        self.go2rtc_api = "http://localhost:1984"

    async def regenerate(self) -> None:
        """Rebuild go2rtc.yaml from all enabled cameras and reload."""
        async with self.db.acquire() as conn:
            cameras = await conn.fetch(
                """SELECT id, name, ip_address, rtsp_main_stream, rtsp_sub_stream
                   FROM cameras WHERE is_enabled = true AND rtsp_main_stream IS NOT NULL"""
            )

        streams = {}
        for cam in cameras:
            # Use short ID for stream name
            cam_id = str(cam["id"]).replace("-", "")[:12]
            safe_name = f"cam_{cam_id}"

            sources = []
            if cam["rtsp_main_stream"]:
                sources.append(cam["rtsp_main_stream"])

            streams[safe_name] = sources

            # Also add sub-stream variant for detection
            if cam["rtsp_sub_stream"] and cam["rtsp_sub_stream"] != cam["rtsp_main_stream"]:
                streams[f"{safe_name}_sub"] = [cam["rtsp_sub_stream"]]

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
        """Signal go2rtc to reload its configuration."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.go2rtc_api}/api/config")
                if resp.status_code == 200:
                    log.info("go2rtc_config.reload_signaled")
                else:
                    log.warning("go2rtc_config.reload_status", status=resp.status_code)
        except httpx.ConnectError:
            log.warning("go2rtc_config.not_reachable", url=self.go2rtc_api)
        except Exception as e:
            log.warning("go2rtc_config.reload_failed", error=str(e))
