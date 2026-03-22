"""Camera routes."""

import json
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


async def _get_redis() -> aioredis.Redis:
    """Get a Redis connection."""
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


async def _publish_camera_event(event_type: str, camera_id: str, ip_address: str = "") -> None:
    """Publish a camera lifecycle event to Redis for camera-manager to pick up."""
    try:
        r = await _get_redis()
        await r.xadd("camera_events", {
            "type": event_type,
            "camera_id": camera_id,
            "ip_address": ip_address,
        })
        await r.close()
    except Exception:
        pass  # Don't fail the API call if Redis is down


def _generate_hikvision_rtsp(ip: str, username: str, password: str) -> tuple[str, str]:
    """Generate Hikvision RTSP URLs for main and sub streams."""
    main = f"rtsp://{username}:{password}@{ip}:554/Streaming/Channels/101"
    sub = f"rtsp://{username}:{password}@{ip}:554/Streaming/Channels/102"
    return main, sub


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
    # Build camera data with auto-generated RTSP URLs
    cam_data = data.model_dump()

    username = cam_data.pop("username", None) or "admin"
    password = cam_data.pop("password", None) or "admin123"

    # Auto-generate RTSP streams (Hikvision format, compatible with most brands)
    rtsp_main, rtsp_sub = _generate_hikvision_rtsp(
        cam_data["ip_address"], username, password
    )
    cam_data["rtsp_main_stream"] = rtsp_main
    cam_data["rtsp_sub_stream"] = rtsp_sub
    cam_data["is_online"] = True
    cam_data["has_ptz"] = cam_data.get("camera_type") == "ptz"
    cam_data["username"] = username
    # Store password encrypted (simple for now, Fernet in production)
    cam_data["password_encrypted"] = password

    camera = await create_camera(db, cam_data)

    # Notify camera-manager to regenerate go2rtc config immediately
    await _publish_camera_event(
        "camera_discovered",
        str(camera.id),
        cam_data["ip_address"],
    )

    return camera


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
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    ip_address = camera.ip_address

    deleted = await delete_camera(db, camera_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Camera not found")

    # Notify camera-manager to remove stream from go2rtc
    await _publish_camera_event(
        "camera_removed",
        str(camera_id),
        ip_address,
    )


@router.post("/probe-onvif")
async def probe_onvif(
    data: dict,
    user: User = Depends(get_current_user),
):
    """Probe an ONVIF camera by IP to get its info and RTSP stream URL."""
    import asyncio

    ip = data.get("ip", "")
    port = int(data.get("port", 80))
    username = data.get("username", "admin")
    password = data.get("password", "")

    if not ip:
        raise HTTPException(status_code=400, detail="IP address is required")

    try:
        from onvif import ONVIFCamera

        loop = asyncio.get_event_loop()

        def _probe():
            cam = ONVIFCamera(ip, port, username, password)

            # Device info
            info = cam.devicemgmt.GetDeviceInformation()
            manufacturer = getattr(info, "Manufacturer", "Unknown")
            model = getattr(info, "Model", "Unknown")
            firmware = getattr(info, "FirmwareVersion", "")

            # Stream URI
            media = cam.create_media_service()
            profiles = media.GetProfiles()
            rtsp_url = ""
            if profiles:
                stream_setup = {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}}
                uri = media.GetStreamUri({"StreamSetup": stream_setup, "ProfileToken": profiles[0].token})
                rtsp_url = uri.Uri
                # Inject credentials
                if rtsp_url and "@" not in rtsp_url:
                    rtsp_url = rtsp_url.replace("rtsp://", f"rtsp://{username}:{password}@")

            # PTZ
            has_ptz = False
            try:
                ptz = cam.create_ptz_service()
                if ptz:
                    has_ptz = True
            except Exception:
                pass

            return {
                "success": True,
                "manufacturer": manufacturer,
                "model": model,
                "firmware": firmware,
                "rtsp_url": rtsp_url,
                "has_ptz": has_ptz,
                "name": f"{manufacturer} {model} ({ip})",
            }

        result = await loop.run_in_executor(None, _probe)
        return result

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "message": f"No se pudo conectar a {ip}:{port} por ONVIF. Verifica IP, puerto, usuario y contraseña.",
        }


@router.post("/discover", status_code=202)
async def trigger_discovery(user: User = Depends(get_current_user)):
    """Trigger ONVIF camera discovery by publishing to Redis."""
    try:
        r = await _get_redis()
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
        r = await _get_redis()
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
