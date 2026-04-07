"""DNS Vision AI - REST API Service

FastAPI backend with JWT authentication, camera/event/zone/alert CRUD,
and WebSocket for live event streaming.
"""

import structlog
from fastapi import FastAPI

from config import settings
from middleware.cors import add_cors_middleware
from routers import auth, cameras, events, zones, alerts, dashboard, ws, system, persons, recordings
from utils.minio_client import ensure_buckets

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

app = FastAPI(
    title="DNS Vision AI",
    description="AI-powered video analytics platform",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# Middleware
add_cors_middleware(app)

# Routers
app.include_router(auth.router, prefix="/api/v1")
app.include_router(cameras.router, prefix="/api/v1")
app.include_router(events.router, prefix="/api/v1")
app.include_router(zones.router, prefix="/api/v1")
app.include_router(alerts.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
app.include_router(ws.router)
app.include_router(system.router, prefix="/api/v1")
app.include_router(persons.router, prefix="/api/v1")
app.include_router(recordings.router, prefix="/api/v1")


@app.on_event("startup")
async def startup():
    log.info("api.starting", version="1.0.0")
    try:
        ensure_buckets()
        log.info("api.minio_buckets_ready")
    except Exception as e:
        log.warning("api.minio_init_failed", error=str(e))

    # Auto-register all camera streams in go2rtc on startup
    try:
        import asyncio
        from database import AsyncSessionLocal as async_session
        from services.camera_service import get_cameras as _get_cams
        from routers.cameras import _register_streams_in_go2rtc

        # Wait a bit for go2rtc to be ready
        await asyncio.sleep(3)

        async with async_session() as db:
            cams = await _get_cams(db, is_enabled=True)
            registered = 0
            for cam in cams:
                if cam.rtsp_main_stream:
                    await _register_streams_in_go2rtc(
                        str(cam.id), cam.rtsp_main_stream, cam.rtsp_sub_stream
                    )
                    registered += 1
            log.info("api.go2rtc_streams_registered", count=registered)
    except Exception as e:
        log.warning("api.go2rtc_init_failed", error=str(e))


@app.get("/health")
async def health():
    return {"status": "ok", "service": "dns-vision-ai-api"}
