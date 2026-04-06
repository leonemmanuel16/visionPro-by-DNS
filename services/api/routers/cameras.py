"""Camera routes."""

import json
import logging
from uuid import UUID

import httpx
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/cameras", tags=["cameras"])

# go2rtc runs on the host network — from within Docker, use host.docker.internal or localhost
GO2RTC_API = "http://go2rtc:1984"  # Docker service name won't work with host networking
# Since API is NOT on host network, we need to reach go2rtc on host port
# go2rtc uses network_mode: host, so we reach it at the Docker host IP
GO2RTC_INTERNAL = "http://host.docker.internal:1984"


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


async def _register_streams_in_go2rtc(camera_id: str, rtsp_main: str, rtsp_sub: str | None = None) -> None:
    """Directly register camera streams in go2rtc via its REST API.

    This is a fallback to ensure streams are available even if camera-manager
    hasn't regenerated yet.
    """
    cam_id = camera_id.replace("-", "")[:12]
    safe_name = f"cam_{cam_id}"

    streams_to_add = {}
    if rtsp_main:
        streams_to_add[safe_name] = rtsp_main
        streams_to_add[f"{safe_name}_h264"] = f"ffmpeg:{safe_name}#video=h264#audio=opus"
    if rtsp_sub and rtsp_sub != rtsp_main:
        streams_to_add[f"{safe_name}_sub"] = rtsp_sub
        streams_to_add[f"{safe_name}_sub_h264"] = f"ffmpeg:{safe_name}_sub#video=h264#audio=opus"

    # Try multiple go2rtc URLs (host.docker.internal for macOS/Windows, localhost for Linux host network)
    go2rtc_urls = [GO2RTC_INTERNAL, "http://localhost:1984"]

    for base_url in go2rtc_urls:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                for name, src in streams_to_add.items():
                    resp = await client.put(
                        f"{base_url}/api/streams",
                        params={"name": name, "src": src},
                    )
                    logger.info(f"go2rtc stream registered: {name} -> {resp.status_code}")
                logger.info(f"All streams registered via {base_url}")
                return  # Success, no need to try other URLs
        except Exception as e:
            logger.warning(f"Failed to register streams via {base_url}: {e}")
            continue

    logger.warning("Could not register streams in go2rtc via any URL")


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

    # Also directly register streams in go2rtc (fallback if camera-manager is slow)
    await _register_streams_in_go2rtc(
        str(camera.id),
        rtsp_main,
        rtsp_sub,
    )

    return camera


@router.post("/{camera_id}/toggle-detection", status_code=200)
async def toggle_detection(
    camera_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Toggle detection on/off for a camera. Publishes event to stop/start detector."""
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    new_state = not camera.is_enabled
    await update_camera(db, camera_id, {"is_enabled": new_state})

    event_type = "camera_online" if new_state else "camera_offline"
    await _publish_camera_event(event_type, str(camera_id), camera.ip_address)

    return {
        "camera_id": str(camera_id),
        "detection_enabled": new_state,
        "message": f"Detección {'activada' if new_state else 'pausada'} para {camera.name}",
    }


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

    # Re-register streams in go2rtc after any camera update
    # (handles codec changes like H.264 → H.265)
    if camera.rtsp_main_stream:
        await _register_streams_in_go2rtc(
            str(camera.id),
            camera.rtsp_main_stream,
            camera.rtsp_sub_stream,
        )
        await _publish_camera_event("camera_online", str(camera.id), camera.ip_address)

    return camera


@router.put("/{camera_id}/settings")
async def update_camera_settings(
    camera_id: UUID,
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save per-camera detection settings (detect_classes, image config) into camera.config JSONB."""
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    # Merge new settings into existing config
    current_config = camera.config or {}
    if "detections" in data:
        current_config["detect_classes"] = data["detections"]
    if "image" in data:
        current_config["image_settings"] = data["image"]

    await update_camera(db, camera_id, {"config": current_config})

    return {
        "camera_id": str(camera_id),
        "config": current_config,
        "message": "Configuracion guardada",
    }


@router.put("/{camera_id}/image")
async def apply_image_settings(
    camera_id: UUID,
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Apply image settings to Hikvision camera via ISAPI.

    Hikvision uses separate endpoints:
    - PUT /ISAPI/Image/channels/1/color → brightness, contrast, saturation
    - PUT /ISAPI/Image/channels/1/Sharpness → sharpness
    - PUT /ISAPI/Image/channels/1/WDR → wide dynamic range on/off
    """
    camera = await get_camera(db, camera_id)
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    ip = camera.ip_address
    username = camera.username or "admin"
    password = camera.password_encrypted or ""

    brightness = max(0, min(100, int(data.get("brightness", 50))))
    contrast = max(0, min(100, int(data.get("contrast", 50))))
    saturation = max(0, min(100, int(data.get("saturation", 50))))
    sharpness = max(0, min(100, int(data.get("sharpness", 50))))
    wdr = data.get("wdr", False)

    auth = httpx.DigestAuth(username, password)
    headers = {"Content-Type": "application/xml"}
    results = {}

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # 1. Brightness, Contrast, Saturation → /color
            color_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Color>
<brightnessLevel>{brightness}</brightnessLevel>
<contrastLevel>{contrast}</contrastLevel>
<saturationLevel>{saturation}</saturationLevel>
</Color>"""
            resp = await client.put(
                f"http://{ip}/ISAPI/Image/channels/1/color",
                content=color_xml, headers=headers, auth=auth,
            )
            results["color"] = resp.status_code

            # 2. Sharpness → separate endpoint
            sharp_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Sharpness>
<sharpnessLevel>{sharpness}</sharpnessLevel>
</Sharpness>"""
            resp2 = await client.put(
                f"http://{ip}/ISAPI/Image/channels/1/Sharpness",
                content=sharp_xml, headers=headers, auth=auth,
            )
            results["sharpness"] = resp2.status_code

            # 3. WDR → separate endpoint
            wdr_mode = "open" if wdr else "close"
            wdr_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<WDR>
<mode>{wdr_mode}</mode>
<WDRLevel>50</WDRLevel>
</WDR>"""
            resp3 = await client.put(
                f"http://{ip}/ISAPI/Image/channels/1/WDR",
                content=wdr_xml, headers=headers, auth=auth,
            )
            results["wdr"] = resp3.status_code

        # Save to DB
        current_config = camera.config or {}
        current_config["image_settings"] = {
            "brightness": brightness, "contrast": contrast,
            "saturation": saturation, "sharpness": sharpness,
            "wdr": wdr,
        }
        await update_camera(db, camera_id, {"config": current_config})

        logger.info(f"ISAPI image results: {results}")
        return {"status": "ok", "results": results, "message": "Imagen aplicada"}

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Timeout conectando a la camara")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ISAPI image error: {e}")
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")


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


@router.delete("/streams/{stream_name}", status_code=200)
async def delete_stream(
    stream_name: str,
    user: User = Depends(get_current_user),
):
    """Delete a stream from go2rtc."""
    go2rtc_urls = [GO2RTC_INTERNAL, "http://localhost:1984"]
    for base_url in go2rtc_urls:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.delete(
                    f"{base_url}/api/streams",
                    params={"name": stream_name},
                )
                return {"message": f"Stream {stream_name} deleted", "status": resp.status_code}
        except Exception:
            continue
    raise HTTPException(500, "Could not reach go2rtc")


@router.post("/refresh-streams", status_code=200)
async def refresh_streams(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Re-register all camera streams in go2rtc. Use when streams are missing."""
    cameras_list = await get_cameras(db, is_enabled=True)
    registered = 0
    for cam in cameras_list:
        if cam.rtsp_main_stream:
            await _register_streams_in_go2rtc(
                str(cam.id),
                cam.rtsp_main_stream,
                cam.rtsp_sub_stream,
            )
            registered += 1
    return {"message": f"Registered {registered} cameras in go2rtc"}


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


@router.post("/import-nvr", status_code=200)
async def import_from_nvr(
    data: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import all cameras from a Hikvision NVR via ISAPI.

    Queries the NVR for connected cameras and auto-creates them in our DB.
    RTSP streams go through the NVR (no individual camera passwords needed).

    Body: {"ip": "192.168.8.3", "username": "visionpro", "password": "Dns2026.", "nvr_port": 554}
    """
    import xml.etree.ElementTree as ET

    nvr_ip = data.get("ip", "")
    nvr_user = data.get("username", "")
    nvr_pass = data.get("password", "")
    nvr_rtsp_port = data.get("nvr_port", 554)

    if not nvr_ip or not nvr_user or not nvr_pass:
        raise HTTPException(400, "ip, username, and password are required")

    # Query NVR for camera channels via ISAPI
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"http://{nvr_ip}/ISAPI/ContentMgmt/InputProxy/channels",
                auth=httpx.DigestAuth(nvr_user, nvr_pass),
            )
            if resp.status_code != 200:
                raise HTTPException(400, f"NVR returned {resp.status_code}: {resp.text[:200]}")
            xml_data = resp.text
    except httpx.ConnectError:
        raise HTTPException(400, f"Could not connect to NVR at {nvr_ip}")

    # Parse XML response
    ns = {"hik": "http://www.hikvision.com/ver20/XMLSchema"}
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError:
        raise HTTPException(400, "Invalid XML response from NVR")

    channels = root.findall(".//hik:InputProxyChannel", ns)
    if not channels:
        # Try without namespace
        channels = root.findall(".//InputProxyChannel")

    # Get existing cameras to avoid duplicates
    existing = await get_cameras(db)
    existing_ips = {c.ip_address for c in existing}

    imported = []
    skipped = []

    for ch in channels:
        def _find(tag: str) -> str:
            el = ch.find(f"hik:{tag}", ns)
            if el is None:
                el = ch.find(tag)
            if el is None:
                # Check in sourceInputPortDescriptor
                desc = ch.find("hik:sourceInputPortDescriptor", ns)
                if desc is None:
                    desc = ch.find("sourceInputPortDescriptor")
                if desc is not None:
                    el = desc.find(f"hik:{tag}", ns)
                    if el is None:
                        el = desc.find(tag)
            return el.text.strip() if el is not None and el.text else ""

        channel_id = _find("id")
        name = _find("name") or f"Camera {channel_id}"
        ip_address = _find("ipAddress")
        model = _find("model")

        if not channel_id or not ip_address:
            continue

        # Skip if already exists by IP
        if ip_address in existing_ips:
            skipped.append({"name": name, "ip": ip_address, "reason": "already exists"})
            continue

        # Build RTSP URLs through the NVR
        ch_num = int(channel_id)
        rtsp_main = f"rtsp://{nvr_user}:{nvr_pass}@{nvr_ip}:{nvr_rtsp_port}/Streaming/Channels/{ch_num}01"
        rtsp_sub = f"rtsp://{nvr_user}:{nvr_pass}@{nvr_ip}:{nvr_rtsp_port}/Streaming/Channels/{ch_num}02"

        # Create camera in DB
        cam_data = {
            "name": name,
            "ip_address": ip_address,
            "onvif_port": 80,
            "manufacturer": "Hikvision",
            "model": model or None,
            "rtsp_main_stream": rtsp_main,
            "rtsp_sub_stream": rtsp_sub,
            "is_enabled": True,
            "is_online": True,
            "has_ptz": False,
            "username": nvr_user,
            "password_encrypted": nvr_pass,
            "config": {"nvr_ip": nvr_ip, "nvr_channel": ch_num},
        }

        try:
            camera = await create_camera(db, cam_data)
            cam_id_str = str(camera.id)

            # Register streams in go2rtc
            await _register_streams_in_go2rtc(cam_id_str, rtsp_main, rtsp_sub)

            # Notify camera-manager
            await _publish_camera_event("camera_discovered", cam_id_str, ip_address)

            existing_ips.add(ip_address)
            imported.append({
                "id": cam_id_str,
                "name": name,
                "ip": ip_address,
                "model": model,
                "nvr_channel": ch_num,
            })
        except Exception as e:
            skipped.append({"name": name, "ip": ip_address, "reason": str(e)})

    return {
        "message": f"Imported {len(imported)} cameras from NVR ({len(skipped)} skipped)",
        "imported": imported,
        "skipped": skipped,
        "nvr_ip": nvr_ip,
    }


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
