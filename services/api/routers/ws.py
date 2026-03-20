"""WebSocket endpoint for live event streaming."""

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
        # Read from detection_events stream
        last_id = "$"  # Only new messages

        while True:
            try:
                messages = await redis.xread(
                    {"detection_events": last_id},
                    count=10,
                    block=1000,  # Block for 1 second
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
                log.warning("ws.read_error", error=str(e))
                await asyncio.sleep(1)

    except WebSocketDisconnect:
        log.info("ws.disconnected", username=username)
    finally:
        await redis.close()
