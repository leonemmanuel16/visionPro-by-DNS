"""Email notification service with rate limiting.

Rate limit: 1 email per camera per minute.
Each alert email includes a thumbnail image of the detection.
"""

import os
import time
import smtplib
import structlog
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from datetime import datetime
from typing import Optional

log = structlog.get_logger()

# Rate limiting: track last email time per camera
_last_email_time: dict[str, float] = {}
RATE_LIMIT_SECONDS = 60  # 1 email per camera per minute


def can_send_email(camera_id: str) -> bool:
    """Check if we can send an email for this camera (rate limit: 1/min)."""
    now = time.time()
    last_sent = _last_email_time.get(camera_id, 0)
    return (now - last_sent) >= RATE_LIMIT_SECONDS


def mark_email_sent(camera_id: str) -> None:
    """Mark that an email was sent for this camera."""
    _last_email_time[camera_id] = time.time()


def get_remaining_cooldown(camera_id: str) -> int:
    """Get remaining seconds before next email can be sent."""
    now = time.time()
    last_sent = _last_email_time.get(camera_id, 0)
    remaining = RATE_LIMIT_SECONDS - (now - last_sent)
    return max(0, int(remaining))


def send_alert_email(
    to_emails: list[str],
    camera_name: str,
    camera_id: str,
    event_type: str,
    label: str,
    confidence: float,
    occurred_at: str,
    snapshot_data: Optional[bytes] = None,
    thumbnail_data: Optional[bytes] = None,
) -> bool:
    """Send an alert email with optional snapshot image.

    Returns True if sent, False if rate limited or failed.
    """
    # Check rate limit
    if not can_send_email(camera_id):
        remaining = get_remaining_cooldown(camera_id)
        log.info(
            "email.rate_limited",
            camera_id=camera_id,
            remaining_seconds=remaining,
        )
        return False

    # SMTP config from environment
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USERNAME", "")
    smtp_pass = os.environ.get("SMTP_PASSWORD", "")
    from_email = os.environ.get("SMTP_FROM_EMAIL", smtp_user)
    from_name = os.environ.get("SMTP_FROM_NAME", "DNS Vision Pro")
    use_tls = os.environ.get("SMTP_USE_TLS", "true").lower() == "true"

    if not smtp_user or not smtp_pass:
        log.warning("email.smtp_not_configured")
        return False

    # Format event type for display
    event_labels = {
        "person_detected": "Persona detectada",
        "vehicle_detected": "Vehiculo detectado",
        "motion_detected": "Movimiento detectado",
        "face_recognized": "Rostro reconocido",
        "face_unknown": "Rostro desconocido",
        "zone_intrusion": "Intrusion en zona",
        "loitering": "Merodeo detectado",
        "camera_offline": "Camara desconectada",
    }
    event_display = event_labels.get(event_type, event_type)

    # Build email
    subject = f"DNS Vision Pro - {event_display} en {camera_name}"

    # Create multipart message
    msg = MIMEMultipart("related")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = ", ".join(to_emails)

    # HTML body
    html = f"""
    <html>
    <body style="font-family: Arial, sans-serif; background-color: #f9fafb; padding: 20px;">
      <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <div style="background-color: #2563eb; padding: 16px 20px; color: white;">
          <h2 style="margin: 0; font-size: 16px;">DNS Vision Pro - Alerta</h2>
        </div>

        <!-- Alert content -->
        <div style="padding: 20px;">
          <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            <h3 style="margin: 0 0 8px 0; color: #991b1b; font-size: 15px;">
              {event_display}
            </h3>
            <table style="font-size: 13px; color: #7f1d1d;">
              <tr><td style="padding: 2px 12px 2px 0; font-weight: bold;">Camara:</td><td>{camera_name}</td></tr>
              <tr><td style="padding: 2px 12px 2px 0; font-weight: bold;">Tipo:</td><td>{label}</td></tr>
              <tr><td style="padding: 2px 12px 2px 0; font-weight: bold;">Confianza:</td><td>{confidence:.0%}</td></tr>
              <tr><td style="padding: 2px 12px 2px 0; font-weight: bold;">Hora:</td><td>{occurred_at}</td></tr>
            </table>
          </div>

          {"<img src='cid:snapshot' style='width: 100%; border-radius: 8px; margin-bottom: 16px;' alt='Deteccion' />" if (snapshot_data or thumbnail_data) else "<div style='background: #f3f4f6; border-radius: 8px; padding: 30px; text-align: center; color: #9ca3af; font-size: 12px; margin-bottom: 16px;'>Imagen no disponible</div>"}

          <p style="font-size: 11px; color: #9ca3af; text-align: center; margin: 0;">
            Este correo fue generado automaticamente por DNS Vision Pro.<br/>
            Limite: 1 correo por camara por minuto.
          </p>
        </div>
      </div>
    </body>
    </html>
    """

    html_part = MIMEText(html, "html")
    msg.attach(html_part)

    # Attach snapshot image if available
    image_data = thumbnail_data or snapshot_data
    if image_data:
        img = MIMEImage(image_data, _subtype="jpeg")
        img.add_header("Content-ID", "<snapshot>")
        img.add_header("Content-Disposition", "inline", filename="detection.jpg")
        msg.attach(img)

    # Send
    try:
        if use_tls:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
            server.starttls()
        else:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10)

        server.login(smtp_user, smtp_pass)
        server.sendmail(from_email, to_emails, msg.as_string())
        server.quit()

        # Mark as sent (rate limit)
        mark_email_sent(camera_id)

        log.info(
            "email.sent",
            camera_id=camera_id,
            camera_name=camera_name,
            event_type=event_type,
            to=to_emails,
        )
        return True

    except Exception as e:
        log.error(
            "email.send_failed",
            camera_id=camera_id,
            error=str(e),
        )
        return False
