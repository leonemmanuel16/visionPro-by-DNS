"""Alert rule routes."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from middleware.auth import get_current_user
from models.alert_rule import AlertRule
from models.user import User
from schemas.alert import AlertRuleCreate, AlertRuleResponse, AlertRuleUpdate

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertRuleResponse])
async def list_alerts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AlertRule).order_by(AlertRule.created_at.desc()))
    return list(result.scalars().all())


@router.post("", response_model=AlertRuleResponse, status_code=201)
async def create_alert(
    data: AlertRuleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = AlertRule(**data.model_dump())
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


@router.put("/{alert_id}", response_model=AlertRuleResponse)
async def update_alert(
    alert_id: UUID,
    data: AlertRuleUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    update_data = data.model_dump(exclude_unset=True)
    if update_data:
        await db.execute(
            sa_update(AlertRule).where(AlertRule.id == alert_id).values(**update_data)
        )
        await db.commit()

    result = await db.execute(select(AlertRule).where(AlertRule.id == alert_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    return rule


@router.delete("/{alert_id}", status_code=204)
async def delete_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(sa_delete(AlertRule).where(AlertRule.id == alert_id))
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Alert rule not found")
