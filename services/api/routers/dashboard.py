"""Dashboard routes."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta, timezone

from database import get_db
from middleware.auth import get_current_user
from models.camera import Camera
from models.event import Event
from models.user import User

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/stats")
async def dashboard_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())

    # Camera counts
    total_result = await db.execute(select(func.count(Camera.id)))
    total_cameras = total_result.scalar() or 0

    online_result = await db.execute(
        select(func.count(Camera.id)).where(Camera.is_online == True)
    )
    online_cameras = online_result.scalar() or 0

    # Event counts
    today_result = await db.execute(
        select(func.count(Event.id)).where(Event.occurred_at >= today_start)
    )
    events_today = today_result.scalar() or 0

    week_result = await db.execute(
        select(func.count(Event.id)).where(Event.occurred_at >= week_start)
    )
    events_week = week_result.scalar() or 0

    return {
        "total_cameras": total_cameras,
        "online_cameras": online_cameras,
        "events_today": events_today,
        "events_this_week": events_week,
    }


@router.get("/recent")
async def recent_events(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Event).order_by(Event.occurred_at.desc()).limit(20)
    )
    events = result.scalars().all()

    # Enrich with camera names
    camera_ids = {e.camera_id for e in events}
    cameras = {}
    if camera_ids:
        cam_result = await db.execute(
            select(Camera.id, Camera.name).where(Camera.id.in_(camera_ids))
        )
        cameras = {row[0]: row[1] for row in cam_result.all()}

    return [
        {
            "id": str(e.id),
            "camera_id": str(e.camera_id),
            "camera_name": cameras.get(e.camera_id, "Unknown"),
            "event_type": e.event_type,
            "label": e.label,
            "confidence": e.confidence,
            "snapshot_path": e.snapshot_path,
            "thumbnail_path": e.thumbnail_path,
            "occurred_at": e.occurred_at.isoformat(),
            "metadata": e.metadata if hasattr(e, "metadata") else {},
        }
        for e in events
    ]
