"""Camera Pydantic schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class CameraCreate(BaseModel):
    name: str
    ip_address: str
    onvif_port: int = 80
    username: str | None = None
    password: str | None = None
    location: str | None = None
    is_enabled: bool = True
    manufacturer: str | None = None
    model: str | None = None
    camera_type: str | None = None


class CameraUpdate(BaseModel):
    name: str | None = None
    ip_address: str | None = None
    onvif_port: int | None = None
    username: str | None = None
    password: str | None = None
    location: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    camera_type: str | None = None
    is_enabled: bool | None = None
    config: dict | None = None


class CameraResponse(BaseModel):
    id: UUID
    name: str
    ip_address: str
    onvif_port: int
    manufacturer: str | None
    model: str | None
    firmware: str | None
    serial_number: str | None
    mac_address: str | None
    rtsp_main_stream: str | None
    rtsp_sub_stream: str | None
    camera_type: str | None
    has_ptz: bool
    location: str | None
    is_enabled: bool
    is_online: bool
    last_seen_at: datetime | None
    config: dict
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PTZCommand(BaseModel):
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0
