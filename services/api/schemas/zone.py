"""Zone Pydantic schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class ZoneCreate(BaseModel):
    camera_id: UUID
    name: str
    zone_type: str  # roi, tripwire, perimeter
    points: list[dict]  # [{x, y}, ...]
    direction: str | None = None
    detect_classes: list[str] = ["person", "vehicle"]
    is_enabled: bool = True
    config: dict = {}


class ZoneUpdate(BaseModel):
    name: str | None = None
    zone_type: str | None = None
    points: list[dict] | None = None
    direction: str | None = None
    detect_classes: list[str] | None = None
    is_enabled: bool | None = None
    config: dict | None = None


class ZoneResponse(BaseModel):
    id: UUID
    camera_id: UUID
    name: str
    zone_type: str
    points: list[dict]
    direction: str | None
    detect_classes: list[str] | None
    is_enabled: bool
    config: dict
    created_at: datetime

    model_config = {"from_attributes": True}
