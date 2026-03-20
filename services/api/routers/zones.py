"""Zone routes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from middleware.auth import get_current_user
from models.user import User
from models.zone import Zone
from schemas.zone import ZoneCreate, ZoneResponse, ZoneUpdate

router = APIRouter(prefix="/zones", tags=["zones"])


@router.get("", response_model=list[ZoneResponse])
async def list_zones(
    camera_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = select(Zone).order_by(Zone.created_at.desc())
    if camera_id:
        query = query.where(Zone.camera_id == camera_id)
    result = await db.execute(query)
    return list(result.scalars().all())


@router.get("/{zone_id}", response_model=ZoneResponse)
async def get_zone(
    zone_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    return zone


@router.post("", response_model=ZoneResponse, status_code=201)
async def create_zone(
    data: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    zone = Zone(**data.model_dump())
    db.add(zone)
    await db.commit()
    await db.refresh(zone)
    return zone


@router.put("/{zone_id}", response_model=ZoneResponse)
async def update_zone(
    zone_id: UUID,
    data: ZoneUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    update_data = data.model_dump(exclude_unset=True)
    if not update_data:
        result = await db.execute(select(Zone).where(Zone.id == zone_id))
        return result.scalar_one_or_none()

    await db.execute(sa_update(Zone).where(Zone.id == zone_id).values(**update_data))
    await db.commit()

    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    return zone


@router.delete("/{zone_id}", status_code=204)
async def delete_zone(
    zone_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(sa_delete(Zone).where(Zone.id == zone_id))
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Zone not found")
