"""Camera service - CRUD operations."""

from uuid import UUID

from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from models.camera import Camera


async def get_cameras(
    db: AsyncSession,
    is_enabled: bool | None = None,
    is_online: bool | None = None,
) -> list[Camera]:
    query = select(Camera).order_by(Camera.name)
    if is_enabled is not None:
        query = query.where(Camera.is_enabled == is_enabled)
    if is_online is not None:
        query = query.where(Camera.is_online == is_online)
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_camera(db: AsyncSession, camera_id: UUID) -> Camera | None:
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    return result.scalar_one_or_none()


async def create_camera(db: AsyncSession, data: dict) -> Camera:
    camera = Camera(**data)
    db.add(camera)
    await db.commit()
    await db.refresh(camera)
    return camera


async def update_camera(db: AsyncSession, camera_id: UUID, data: dict) -> Camera | None:
    # Filter out None values
    update_data = {k: v for k, v in data.items() if v is not None}
    if not update_data:
        return await get_camera(db, camera_id)

    await db.execute(
        update(Camera).where(Camera.id == camera_id).values(**update_data)
    )
    await db.commit()
    return await get_camera(db, camera_id)


async def delete_camera(db: AsyncSession, camera_id: UUID) -> bool:
    result = await db.execute(delete(Camera).where(Camera.id == camera_id))
    await db.commit()
    return result.rowcount > 0
