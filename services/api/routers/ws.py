"""WebSocket endpoint for live event streaming and tracking overlays."""

import asyncio
import json

import redis.asyncio as aioredis
import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from config import settings
from utils.security import verify_token

log = structlog.get_logger()

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(None),
):
    # Authenticate
    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    payload = verify_token(token)
    if not payload or payload.get("type") != "access":
        await websocket.close(code=4001, reason="Invalid token")
        return

    await websocket.accept()
    username = payload.get("username", "unknown")
    log.info("ws.connected", username=username)

    redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)

    try:
        # Two concurrent tasks:
        # 1. Read detection events from Redis Stream (debounced alerts)
        # 2. Subscribe to tracking pub/sub (real-time bounding boxes)

        async def read_events():
            """Read debounced detection events from Redis Stream."""
            last_id = "$"
            while True:
                try:
                    messages = await redis.xread(
                        {"detection_events": last_id},
                        count=10,
                        block=1000,
                    )
                    for stream, entries in messages:
                        for entry_id, data in entries:
                            last_id = entry_id
                            await websocket.send_json({
                                "type": "detection",
                                "event": data,
                            })
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    log.warning("ws.events_error", error=str(e))
                    await asyncio.sleep(1)

        async def read_tracking():
            """Subscribe to real-time tracking pub/sub for live bounding boxes."""
            pubsub = redis.pubsub()
            await pubsub.subscribe("tracking")
            try:
                while True:
                    msg = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                    if msg and msg["type"] == "message":
                        try:
                            data = json.loads(msg["data"])
                            await websocket.send_json({
                                "type": "tracking",
                                "camera_id": data.get("camera_id"),
                                "tracks": data.get("tracks", []),
                            })
                        except Exception:
                            pass
                    await asyncio.sleep(0.05)  # ~20fps max relay rate
            except asyncio.CancelledError:
                pass
            finally:
                await pubsub.unsubscribe("tracking")
                await pubsub.close()

        # Run both tasks concurrently
        await asyncio.gather(read_events(), read_tracking())

    except WebSocketDisconnect:
        log.info("ws.disconnected", username=username)
    finally:
        await redis.close()
