"""Camera routes."""

from uuid import UUID

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db
from middleware.auth import get_current_user
from models.user import User
from schemas.camera import CameraCreate, CameraResponse, CameraUpdate, PTZCommand
from services.camera_service import (
    create_camera,
    delete_camera,
    get_camera,
    get_cameras,
    update_camera,
)

router = APIRouter(prefix="/cameras", tags=["cameras"])


@router.get("", response_model=list[CameraResponse])
async def list_cameras(
    is_enabled: bool | None = None,
    is_online: bool | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_cameras(db, is_enabled=is_enabled, is_online=is_online)


@router.get("/{camera_id}", response_model=CameraResponse)
async def get_camera_detail(
    camera_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@router.post("", response_model=CameraResponse, status_code=201)
async def add_camera(
    data: CameraCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await create_camera(db, data.model_dump())


@router.put("/{camera_id}", response_model=CameraResponse)
async def update_camera_route(
    camera_id: UUID,
    data: CameraUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    camera = await update_camera(db, camera_id, data.model_dump(exclude_unset=True))
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@router.delete("/{camera_id}", status_code=204)
async def delete_camera_route(
    camera_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    deleted = await delete_camera(db, camera_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Camera not found")


@router.post("/discover", status_code=202)
async def trigger_discovery(user: User = Depends(get_current_user)):
    """Trigger ONVIF camera discovery by publishing to Redis."""
    try:
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.xadd("camera_events", {"type": "discover_request"})
        await r.close()
        return {"message": "Discovery triggered"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to trigger discovery: {e}")


@router.post("/{camera_id}/ptz")
async def ptz_control(
    camera_id: UUID,
    cmd: PTZCommand,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    if not camera.has_ptz:
        raise HTTPException(status_code=400, detail="Camera does not support PTZ")

    # Publish PTZ command to Redis for camera-manager to execute
    try:
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        await r.xadd(
            "camera_events",
            {
                "type": "ptz_command",
                "camera_id": str(camera_id),
                "pan": str(cmd.pan),
                "tilt": str(cmd.tilt),
                "zoom": str(cmd.zoom),
            },
        )
        await r.close()
        return {"message": "PTZ command sent"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PTZ command failed: {e}")
