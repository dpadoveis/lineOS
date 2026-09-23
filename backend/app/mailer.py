"""Sending a share invitation by email, over SMTP, on the standard library.

Optional by design: with `SMTP_HOST` unset the API answers 503 and the editor
falls back to opening the visitor's own mail client (`mailto:`) with the link
already in the body. The feature therefore works before any credential exists,
and starts going out from the server the moment one does.
"""
import logging
import smtplib
from email.message import EmailMessage

from fastapi import HTTPException, status

from .config import settings

logger = logging.getLogger("flow.mailer")


def configured() -> bool:
    return bool(settings.smtp_host and (settings.smtp_from or settings.smtp_user))


def send(to: str, subject: str, body: str) -> None:
    """Sends one plain-text message. 503 when SMTP is not configured."""
    if not configured():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "email sending is not configured on this server",
        )
    message = EmailMessage()
    message["From"] = settings.smtp_from or settings.smtp_user
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(message)
    except HTTPException:
        raise
    except Exception as err:  # noqa: BLE001 -- the reason belongs in the response
        logger.exception("SMTP send failed")
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"the mail server refused the message: {err}"
        ) from err
