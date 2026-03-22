"""Event routes."""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from middleware.auth import get_current_user
from models.user import User
from schemas.event import EventResponse, EventStatsResponse
from services.event_service import get_event, get_events, get_event_stats
from utils.minio_client import get_object_data

router = APIRouter(prefix="/events", tags=["events"])


@router.get("", response_model=list[EventResponse])
async def list_events(
    camera_id: UUID | None = None,
    event_type: str | None = None,
    from_date: datetime | None = Query(None, alias="from"),
    to_date: datetime | None = Query(None, alias="to"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    events, total = await get_events(
        db, camera_id, event_type, from_date, to_date, page, per_page
    )
    return events


@router.get("/stats", response_model=EventStatsResponse)
async def event_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_event_stats(db)


@router.get("/{event_id}", response_model=EventResponse)
async def get_event_detail(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    event = await get_event(db, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@router.get("/{event_id}/snapshot")
async def get_snapshot(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Serve snapshot image directly. No auth — used in <img> tags."""
    event = await get_event(db, event_id)
    if not event or not event.snapshot_path:
        raise HTTPException(status_code=404, detail="Snapshot not found")

    parts = event.snapshot_path.split("/", 1)
    try:
        data = get_object_data(parts[0], parts[1])
        return Response(
            content=data,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception:
        raise HTTPException(status_code=404, detail="Snapshot file not found in storage")


@router.get("/{event_id}/thumbnail")
async def get_thumbnail(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Serve thumbnail image directly. No auth — used in <img> tags."""
    event = await get_event(db, event_id)
    if not event or not event.thumbnail_path:
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    parts = event.thumbnail_path.split("/", 1)
    try:
        data = get_object_data(parts[0], parts[1])
        return Response(
            content=data,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except Exception:
        raise HTTPException(status_code=404, detail="Thumbnail file not found in storage")


@router.get("/{event_id}/clip")
async def get_clip(
    event_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    event = await get_event(db, event_id)
    if not event or not event.clip_path:
        raise HTTPException(status_code=404, detail="Clip not found")
    parts = event.clip_path.split("/", 1)
    try:
        data = get_object_data(parts[0], parts[1])
        return Response(content=data, media_type="video/mp4")
    except Exception:
        raise HTTPException(status_code=404, detail="Clip file not found in storage")
