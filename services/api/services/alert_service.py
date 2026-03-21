"""Alert service - send notifications via webhook, WhatsApp, email."""

import json
import os
from datetime import datetime, timezone

import httpx
import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models.alert_rule import AlertRule
from utils.minio_client import get_presigned_url, get_object_data
from services.email_service import send_alert_email, can_send_email

log = structlog.get_logger()


async def get_alert_rules(db: AsyncSession) -> list[AlertRule]:
    result = await db.execute(select(AlertRule).order_by(AlertRule.created_at.desc()))
    return list(result.scalars().all())


async def check_and_send_alerts(
    db: AsyncSession,
    event_data: dict,
) -> None:
    """Check event against alert rules and send notifications."""
    camera_id = event_data.get("camera_id")
    event_type = event_data.get("event_type")
    zone_id = event_data.get("zone_id")

    # Find matching rules
    query = select(AlertRule).where(
        AlertRule.is_enabled == True,
        AlertRule.event_types.any(event_type),
    )

    result = await db.execute(query)
    rules = result.scalars().all()

    now = datetime.now(timezone.utc)

    for rule in rules:
        # Check camera filter
        if rule.camera_id and str(rule.camera_id) != str(camera_id):
            continue

        # Check zone filter
        if rule.zone_id and str(rule.zone_id) != str(zone_id):
            continue

        # Check cooldown
        if rule.last_triggered_at:
            elapsed = (now - rule.last_triggered_at).total_seconds()
            if elapsed < rule.cooldown_seconds:
                continue

        # Check schedule
        if rule.schedule and not _is_within_schedule(rule.schedule, now):
            continue

        # Send alert
        try:
            await _send_alert(rule, event_data)
            # Update last triggered
            await db.execute(
                update(AlertRule)
                .where(AlertRule.id == rule.id)
                .values(last_triggered_at=now)
            )
            await db.commit()
            log.info("alert.sent", rule_id=str(rule.id), channel=rule.channel)
        except Exception as e:
            log.error("alert.send_failed", rule_id=str(rule.id), error=str(e))


async def _send_alert(rule: AlertRule, event_data: dict) -> None:
    """Send alert via the configured channel."""
    # Build snapshot URL if available
    snapshot_url = None
    if event_data.get("snapshot_path"):
        parts = event_data["snapshot_path"].split("/", 1)
        if len(parts) == 2:
            snapshot_url = get_presigned_url(parts[0], parts[1])

    message = (
        f"🚨 {event_data.get('event_type', 'Detection').upper()} Alert\n"
        f"Camera: {event_data.get('camera_name', 'Unknown')}\n"
        f"Type: {event_data.get('label', event_data.get('event_type'))}\n"
        f"Confidence: {event_data.get('confidence', 0):.0%}\n"
        f"Time: {event_data.get('occurred_at', 'Unknown')}"
    )

    async with httpx.AsyncClient(timeout=10.0) as client:
        if rule.channel == "webhook":
            await client.post(
                rule.target,
                json={
                    "text": message,
                    "event": event_data,
                    "snapshot_url": snapshot_url,
                },
            )
        elif rule.channel == "whatsapp":
            whatsapp_url = os.environ.get("WHATSAPP_WEBHOOK_URL", rule.target)
            await client.post(
                whatsapp_url,
                json={
                    "phone": rule.target,
                    "message": message,
                    "image_url": snapshot_url,
                },
            )
        elif rule.channel == "email":
            # Check per-camera rate limit (1 email per minute)
            cam_id = str(event_data.get("camera_id", "unknown"))
            if not can_send_email(cam_id):
                log.info("alert.email_rate_limited", camera_id=cam_id, rule=rule.name)
                return

            # Get snapshot image data if available
            thumbnail_data = None
            if event_data.get("thumbnail_path"):
                try:
                    parts = event_data["thumbnail_path"].split("/", 1)
                    if len(parts) == 2:
                        thumbnail_data = get_object_data(parts[0], parts[1])
                except Exception:
                    pass  # Send without image

            to_emails = [e.strip() for e in rule.target.split(",") if e.strip()]
            send_alert_email(
                to_emails=to_emails,
                camera_name=event_data.get("camera_name", "Unknown"),
                camera_id=cam_id,
                event_type=event_data.get("event_type", "detection"),
                label=event_data.get("label", "unknown"),
                confidence=event_data.get("confidence", 0),
                occurred_at=event_data.get("occurred_at", ""),
                thumbnail_data=thumbnail_data,
            )


def _is_within_schedule(schedule: dict, now: datetime) -> bool:
    """Check if current time is within the alert schedule."""
    if not schedule:
        return True

    # Check day of week (1=Monday, 7=Sunday)
    days = schedule.get("days", [1, 2, 3, 4, 5, 6, 7])
    if now.isoweekday() not in days:
        return False

    # Check time window
    start_str = schedule.get("start", "00:00")
    end_str = schedule.get("end", "23:59")

    start_h, start_m = map(int, start_str.split(":"))
    end_h, end_m = map(int, end_str.split(":"))

    current_minutes = now.hour * 60 + now.minute
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m

    if start_minutes <= end_minutes:
        return start_minutes <= current_minutes <= end_minutes
    else:
        # Overnight schedule (e.g., 20:00 - 06:00)
        return current_minutes >= start_minutes or current_minutes <= end_minutes
