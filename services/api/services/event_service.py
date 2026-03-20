"""Event service - queries and statistics."""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from models.event import Event


async def get_events(
    db: AsyncSession,
    camera_id: UUID | None = None,
    event_type: str | None = None,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    page: int = 1,
    per_page: int = 50,
) -> tuple[list[Event], int]:
    query = select(Event).order_by(Event.occurred_at.desc())
    count_query = select(func.count(Event.id))

    if camera_id:
        query = query.where(Event.camera_id == camera_id)
        count_query = count_query.where(Event.camera_id == camera_id)
    if event_type:
        query = query.where(Event.event_type == event_type)
        count_query = count_query.where(Event.event_type == event_type)
    if from_date:
        query = query.where(Event.occurred_at >= from_date)
        count_query = count_query.where(Event.occurred_at >= from_date)
    if to_date:
        query = query.where(Event.occurred_at <= to_date)
        count_query = count_query.where(Event.occurred_at <= to_date)

    # Pagination
    offset = (page - 1) * per_page
    query = query.offset(offset).limit(per_page)

    result = await db.execute(query)
    events = list(result.scalars().all())

    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    return events, total


async def get_event(db: AsyncSession, event_id: UUID) -> Event | None:
    result = await db.execute(select(Event).where(Event.id == event_id))
    return result.scalar_one_or_none()


async def get_event_stats(db: AsyncSession) -> dict:
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=now.weekday())

    # Events today
    result = await db.execute(
        select(func.count(Event.id)).where(Event.occurred_at >= today_start)
    )
    total_today = result.scalar() or 0

    # Events this week
    result = await db.execute(
        select(func.count(Event.id)).where(Event.occurred_at >= week_start)
    )
    total_week = result.scalar() or 0

    # By type
    result = await db.execute(
        select(Event.event_type, func.count(Event.id))
        .where(Event.occurred_at >= today_start)
        .group_by(Event.event_type)
    )
    by_type = {row[0]: row[1] for row in result.all()}

    # By camera (last 24h)
    result = await db.execute(
        select(Event.camera_id, func.count(Event.id))
        .where(Event.occurred_at >= now - timedelta(hours=24))
        .group_by(Event.camera_id)
    )
    by_camera = {str(row[0]): row[1] for row in result.all()}

    # By hour (last 24h)
    result = await db.execute(
        text("""
            SELECT date_trunc('hour', occurred_at) as hour, count(*)
            FROM events
            WHERE occurred_at >= NOW() - INTERVAL '24 hours'
            GROUP BY hour
            ORDER BY hour
        """)
    )
    by_hour = [{"hour": str(row[0]), "count": row[1]} for row in result.all()]

    return {
        "total_today": total_today,
        "total_week": total_week,
        "by_type": by_type,
        "by_camera": by_camera,
        "by_hour": by_hour,
    }
