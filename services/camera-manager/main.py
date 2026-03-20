"""DNS Vision AI - Camera Manager Service

Discovers ONVIF cameras on the network, manages their lifecycle,
and auto-generates go2rtc streaming configuration.
"""

import asyncio
import os
import signal
import sys

import asyncpg
import redis.asyncio as aioredis
import structlog

from onvif_discovery import ONVIFDiscovery
from onvif_client import ONVIFClient
from camera_registry import CameraRegistry
from health_monitor import HealthMonitor
from go2rtc_config import Go2RTCConfigManager

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()


class CameraManagerService:
    def __init__(self):
        self.redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
        self.postgres_url = os.environ.get(
            "POSTGRES_URL", "postgresql://vision:changeme@localhost:5432/visionai"
        )
        self.discovery_interval = int(os.environ.get("DISCOVERY_INTERVAL", "300"))
        self.health_check_interval = int(os.environ.get("HEALTH_CHECK_INTERVAL", "60"))
        self.onvif_user = os.environ.get("ONVIF_DEFAULT_USER", "admin")
        self.onvif_pass = os.environ.get("ONVIF_DEFAULT_PASS", "admin123")
        self.go2rtc_config_path = os.environ.get(
            "GO2RTC_CONFIG_PATH", "/config/go2rtc.yaml"
        )

        self.db_pool: asyncpg.Pool | None = None
        self.redis: aioredis.Redis | None = None
        self.running = True

    async def start(self):
        log.info("camera_manager.starting", version="1.0.0")

        # Connect to databases
        self.db_pool = await asyncpg.create_pool(
            self.postgres_url, min_size=2, max_size=10
        )
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)

        # Test connections
        async with self.db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        await self.redis.ping()
        log.info("camera_manager.connected", postgres=True, redis=True)

        # Initialize components
        registry = CameraRegistry(self.db_pool, self.redis)
        discovery = ONVIFDiscovery()
        client = ONVIFClient(self.onvif_user, self.onvif_pass)
        health_monitor = HealthMonitor(self.db_pool, self.redis)
        go2rtc_config = Go2RTCConfigManager(self.db_pool, self.go2rtc_config_path)

        # Run initial discovery
        await self._run_discovery(discovery, client, registry, go2rtc_config)

        # Start background tasks
        tasks = [
            asyncio.create_task(
                self._discovery_loop(discovery, client, registry, go2rtc_config)
            ),
            asyncio.create_task(self._health_loop(health_monitor)),
        ]

        log.info(
            "camera_manager.started",
            discovery_interval=self.discovery_interval,
            health_check_interval=self.health_check_interval,
        )

        # Wait for shutdown
        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            log.info("camera_manager.shutting_down")

    async def _run_discovery(self, discovery, client, registry, go2rtc_config):
        """Run a single discovery cycle."""
        try:
            log.info("discovery.starting")
            endpoints = await discovery.discover()
            log.info("discovery.found", count=len(endpoints))

            for endpoint in endpoints:
                try:
                    camera_info = await client.get_camera_info(endpoint)
                    if camera_info:
                        await registry.register_camera(camera_info)
                        log.info(
                            "discovery.camera_registered",
                            ip=camera_info.get("ip_address"),
                            manufacturer=camera_info.get("manufacturer"),
                        )
                except Exception as e:
                    log.warning("discovery.camera_failed", endpoint=endpoint, error=str(e))

            # Regenerate go2rtc config
            await go2rtc_config.regenerate()
            log.info("discovery.complete")
        except Exception as e:
            log.error("discovery.error", error=str(e))

    async def _discovery_loop(self, discovery, client, registry, go2rtc_config):
        """Periodically discover new cameras."""
        while self.running:
            await asyncio.sleep(self.discovery_interval)
            await self._run_discovery(discovery, client, registry, go2rtc_config)

    async def _health_loop(self, health_monitor):
        """Periodically check camera health."""
        while self.running:
            await asyncio.sleep(self.health_check_interval)
            try:
                await health_monitor.check_all()
            except Exception as e:
                log.error("health_check.error", error=str(e))

    async def stop(self):
        self.running = False
        if self.db_pool:
            await self.db_pool.close()
        if self.redis:
            await self.redis.close()
        log.info("camera_manager.stopped")


async def main():
    service = CameraManagerService()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(service.stop()))

    try:
        await service.start()
    except KeyboardInterrupt:
        await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
