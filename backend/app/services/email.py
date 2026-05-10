import asyncio
import json
import logging
from string import Template
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import settings
from app.services.email_templates import PASSWORD_RESET_HTML, VERIFICATION_HTML

logger = logging.getLogger(__name__)
_RESEND_EMAILS_URL = "https://api.resend.com/emails"


def _expiry_text(hours: int) -> str:
    unit = "hour" if hours == 1 else "hours"
    return f"This link expires in {hours} {unit}."


async def send_verification_email(email: str, verification_url: str) -> None:
    if not settings.resend_api_key:
        logger.debug("Email verification link for %s: %s", email, verification_url)
        return
    try:
        await asyncio.to_thread(_send_verification_sync, email, verification_url)
    except RuntimeError:
        logger.exception("Failed to send verification email to %s", email)


async def send_password_reset_email(email: str, reset_url: str) -> None:
    if not settings.resend_api_key:
        logger.debug("Password reset link for %s: %s", email, reset_url)
        return
    try:
        await asyncio.to_thread(_send_password_reset_sync, email, reset_url)
    except RuntimeError:
        logger.exception("Failed to send password reset email to %s", email)


def _send_verification_sync(email: str, verification_url: str) -> None:
    expiry = _expiry_text(settings.email_verification_expire_hours)
    _call_resend(
        to=email,
        subject="Verify your FrontDashboard email",
        html=Template(VERIFICATION_HTML).substitute(verification_url=verification_url, expiry_text=expiry),
        text=f"Welcome to FrontDashboard.\n\nVerify your email address here:\n{verification_url}\n\n{expiry}",
    )


def _send_password_reset_sync(email: str, reset_url: str) -> None:
    expiry = _expiry_text(settings.password_reset_expire_hours)
    _call_resend(
        to=email,
        subject="Reset your FrontDashboard password",
        html=Template(PASSWORD_RESET_HTML).substitute(reset_url=reset_url, expiry_text=expiry),
        text=f"Reset your FrontDashboard password here:\n{reset_url}\n\n{expiry}\n\nIf you did not request this, you can ignore this email.",
    )


def _call_resend(*, to: str, subject: str, html: str, text: str) -> None:
    payload = {
        "from": settings.email_from,
        "to": [to],
        "subject": subject,
        "html": html,
        "text": text,
    }
    data = json.dumps(payload).encode()
    request = Request(
        _RESEND_EMAILS_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {settings.resend_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "frontdashboard/0.1",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=10):
            pass
    except HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"Resend email request failed with status {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Resend email request failed: {exc.reason}") from exc
