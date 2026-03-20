"""Alert Rule Pydantic schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class AlertRuleCreate(BaseModel):
    name: str
    camera_id: UUID | None = None
    zone_id: UUID | None = None
    event_types: list[str]
    channel: str  # whatsapp, webhook, email
    target: str  # phone, URL, or email
    cooldown_seconds: int = 60
    schedule: dict | None = None
    is_enabled: bool = True


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    camera_id: UUID | None = None
    zone_id: UUID | None = None
    event_types: list[str] | None = None
    channel: str | None = None
    target: str | None = None
    cooldown_seconds: int | None = None
    schedule: dict | None = None
    is_enabled: bool | None = None


class AlertRuleResponse(BaseModel):
    id: UUID
    name: str
    camera_id: UUID | None
    zone_id: UUID | None
    event_types: list[str]
    channel: str
    target: str
    cooldown_seconds: int
    schedule: dict | None
    is_enabled: bool
    last_triggered_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}
