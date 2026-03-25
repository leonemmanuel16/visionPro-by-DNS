"""Alert rule routes."""

import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from middleware.auth import get_current_user
from models.alert_rule import AlertRule
from models.user import User
from schemas.alert import AlertRuleCreate, AlertRuleResponse, AlertRuleUpdate

router = APIRouter(prefix="/alerts", tags=["alerts"])


class SmtpConfig(BaseModel):
    host: str
    port: str = "587"
    username: str
    password: str
    from_email: str = ""
    from_name: str = "DNS Vision Pro"
    use_tls: bool = True


class TestEmailRequest(BaseModel):
    to: str
    smtp: SmtpConfig


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


@router.post("/test-email")
async def test_email(
    data: TestEmailRequest,
    user: User = Depends(get_current_user),
):
    """Send a test email to verify SMTP configuration."""
    smtp_cfg = data.smtp
    sender = smtp_cfg.from_email or smtp_cfg.username
    sender_name = smtp_cfg.from_name or "DNS Vision Pro"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "🔔 DNS Vision Pro — Prueba de Correo"
    msg["From"] = f"{sender_name} <{sender}>"
    msg["To"] = data.to

    html = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1e293b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">🔔 DNS Vision Pro</h2>
        <p style="margin: 5px 0 0; opacity: 0.8;">Prueba de Notificación por Correo</p>
      </div>
      <div style="padding: 20px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
        <p>¡Hola! Este es un correo de prueba enviado desde <strong>DNS Vision Pro</strong>.</p>
        <p>Si recibes este mensaje, tu configuración SMTP es correcta y las alertas por correo funcionarán.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8;">
          Servidor SMTP: {smtp_cfg.host}:{smtp_cfg.port}<br/>
          Remitente: {sender}<br/>
          Destinatario: {data.to}
        </p>
      </div>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    try:
        port = int(smtp_cfg.port)
        if smtp_cfg.use_tls:
            server = smtplib.SMTP(smtp_cfg.host, port, timeout=15)
            server.starttls()
        else:
            server = smtplib.SMTP(smtp_cfg.host, port, timeout=15)

        server.login(smtp_cfg.username, smtp_cfg.password)
        server.sendmail(sender, [data.to], msg.as_string())
        server.quit()

        return {"success": True, "message": f"Email de prueba enviado a {data.to}"}
    except smtplib.SMTPAuthenticationError:
        raise HTTPException(status_code=400, detail="Error de autenticación SMTP. Verifica usuario y contraseña.")
    except smtplib.SMTPConnectError:
        raise HTTPException(status_code=400, detail=f"No se pudo conectar a {smtp_cfg.host}:{smtp_cfg.port}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error al enviar email: {str(e)}")
