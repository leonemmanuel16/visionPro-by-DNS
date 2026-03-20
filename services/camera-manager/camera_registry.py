"""Camera Registry - Track discovered cameras in PostgreSQL and Redis."""

import json
from typing import Any
from uuid import UUID

import asyncpg
import redis.asyncio as aioredis
import structlog

log = structlog.get_logger()


class CameraRegistry:
    """Manages camera records in PostgreSQL with Redis caching."""

    def __init__(self, db_pool: asyncpg.Pool, redis: aioredis.Redis):
        self.db = db_pool
        self.redis = redis

    async def register_camera(self, camera_info: dict[str, Any]) -> UUID:
        """Insert or update a camera record. Returns camera ID."""
        async with self.db.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO cameras (
                    name, ip_address, onvif_port, username, password_encrypted,
                    manufacturer, model, firmware, serial_number, mac_address,
                    rtsp_main_stream, rtsp_sub_stream, onvif_profile_token,
                    has_ptz, is_online, last_seen_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW())
                ON CONFLICT (ip_address) DO UPDATE SET
                    manufacturer = EXCLUDED.manufacturer,
                    model = EXCLUDED.model,
                    firmware = EXCLUDED.firmware,
                    serial_number = EXCLUDED.serial_number,
                    mac_address = EXCLUDED.mac_address,
                    rtsp_main_stream = EXCLUDED.rtsp_main_stream,
                    rtsp_sub_stream = EXCLUDED.rtsp_sub_stream,
                    onvif_profile_token = EXCLUDED.onvif_profile_token,
                    has_ptz = EXCLUDED.has_ptz,
                    is_online = true,
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING id
                """,
                camera_info.get("name", "Unknown Camera"),
                camera_info["ip_address"],
                camera_info.get("onvif_port", 80),
                camera_info.get("username"),
                camera_info.get("password_encrypted"),
                camera_info.get("manufacturer"),
                camera_info.get("model"),
                camera_info.get("firmware"),
                camera_info.get("serial_number"),
                camera_info.get("mac_address"),
                camera_info.get("rtsp_main_stream"),
                camera_info.get("rtsp_sub_stream"),
                camera_info.get("onvif_profile_token"),
                camera_info.get("has_ptz", False),
            )
            camera_id = row["id"]

        # Cache in Redis
        cache_data = {
            "id": str(camera_id),
            "name": camera_info.get("name", "Unknown"),
            "ip_address": camera_info["ip_address"],
            "rtsp_main_stream": camera_info.get("rtsp_main_stream", ""),
            "rtsp_sub_stream": camera_info.get("rtsp_sub_stream", ""),
            "is_online": "true",
        }
        await self.redis.hset(f"cameras:{camera_id}", mapping=cache_data)

        # Publish event
        event = {
            "type": "camera_discovered",
            "camera_id": str(camera_id),
            "ip_address": camera_info["ip_address"],
            "name": camera_info.get("name", "Unknown"),
        }
        await self.redis.xadd("camera_events", event)

        log.info("registry.camera_registered", camera_id=str(camera_id), ip=camera_info["ip_address"])
        return camera_id

    async def get_all_cameras(self) -> list[dict]:
        """Get all enabled cameras from the database."""
        async with self.db.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM cameras WHERE is_enabled = true ORDER BY name"
            )
            return [dict(row) for row in rows]

    async def get_camera(self, camera_id: str) -> dict | None:
        """Get a single camera by ID."""
        async with self.db.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM cameras WHERE id = $1", camera_id)
            return dict(row) if row else None

    async def update_camera_status(
        self, camera_id: str, is_online: bool
    ) -> None:
        """Update camera online status."""
        async with self.db.acquire() as conn:
            if is_online:
                await conn.execute(
                    "UPDATE cameras SET is_online = true, last_seen_at = NOW(), updated_at = NOW() WHERE id = $1",
                    camera_id,
                )
            else:
                await conn.execute(
                    "UPDATE cameras SET is_online = false, updated_at = NOW() WHERE id = $1",
                    camera_id,
                )

        # Update Redis cache
        await self.redis.hset(f"cameras:{camera_id}", "is_online", str(is_online).lower())

        # Publish status event
        event_type = "camera_online" if is_online else "camera_offline"
        await self.redis.xadd(
            "camera_events",
            {"type": event_type, "camera_id": str(camera_id)},
        )
