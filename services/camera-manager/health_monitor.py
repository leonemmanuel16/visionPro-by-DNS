"""Health Monitor - Periodically check camera connectivity."""

import asyncio
import socket

import asyncpg
import redis.asyncio as aioredis
import structlog

log = structlog.get_logger()


class HealthMonitor:
    """Monitors camera health by checking RTSP port connectivity."""

    def __init__(self, db_pool: asyncpg.Pool, redis: aioredis.Redis):
        self.db = db_pool
        self.redis = redis

    async def check_all(self) -> dict:
        """Check health of all enabled cameras. Returns summary."""
        async with self.db.acquire() as conn:
            cameras = await conn.fetch(
                "SELECT id, name, ip_address, onvif_port, is_online FROM cameras WHERE is_enabled = true"
            )

        online = 0
        offline = 0
        changed = 0

        tasks = [self._check_camera(dict(cam)) for cam in cameras]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for cam, result in zip(cameras, results):
            if isinstance(result, Exception):
                is_reachable = False
            else:
                is_reachable = result

            was_online = cam["is_online"]

            if is_reachable:
                online += 1
            else:
                offline += 1

            # Update if status changed
            if is_reachable != was_online:
                changed += 1
                await self._update_status(str(cam["id"]), is_reachable, cam["name"])
            elif is_reachable:
                # Update last_seen even if status didn't change
                async with self.db.acquire() as conn:
                    await conn.execute(
                        "UPDATE cameras SET last_seen_at = NOW() WHERE id = $1",
                        cam["id"],
                    )

        log.info(
            "health_check.complete",
            total=len(cameras),
            online=online,
            offline=offline,
            status_changes=changed,
        )
        return {"total": len(cameras), "online": online, "offline": offline}

    async def _check_camera(self, camera: dict) -> bool:
        """Check if a camera is reachable via TCP connection to ONVIF port."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            self._tcp_check,
            camera["ip_address"],
            camera["onvif_port"],
        )

    @staticmethod
    def _tcp_check(ip: str, port: int, timeout: float = 3.0) -> bool:
        """Try to open a TCP connection to check if host is reachable."""
        try:
            sock = socket.create_connection((ip, port), timeout=timeout)
            sock.close()
            return True
        except (socket.timeout, ConnectionRefusedError, OSError):
            return False

    async def _update_status(self, camera_id: str, is_online: bool, name: str) -> None:
        """Update camera status in DB and publish event."""
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

        # Publish event
        event_type = "camera_online" if is_online else "camera_offline"
        await self.redis.xadd(
            "camera_events",
            {"type": event_type, "camera_id": camera_id, "name": name},
        )

        status_str = "online" if is_online else "offline"
        log.info(f"health_check.status_changed", camera_id=camera_id, name=name, status=status_str)
