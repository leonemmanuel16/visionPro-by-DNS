"""Event Pydantic schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class EventResponse(BaseModel):
    id: UUID
    camera_id: UUID
    event_type: str
    label: str | None
    confidence: float | None
    bbox: dict | None
    zone_id: UUID | None
    snapshot_path: str | None
    clip_path: str | None
    thumbnail_path: str | None
    metadata: dict = Field(validation_alias="event_metadata")
    occurred_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class EventFilter(BaseModel):
    camera_id: UUID | None = None
    event_type: str | None = None
    from_date: datetime | None = None
    to_date: datetime | None = None
    page: int = 1
    per_page: int = 50


class EventStatsResponse(BaseModel):
    total_today: int
    total_week: int
    by_type: dict[str, int]
    by_camera: dict[str, int]
    by_hour: list[dict]
