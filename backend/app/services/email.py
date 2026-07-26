import asyncio
import json
import logging
from dataclasses import dataclass
from string import Template
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import Environment, settings
from app.services.dev_mail import write_dev_message
from app.services.email_templates import EXISTING_ACCOUNT_HTML, PASSWORD_RESET_HTML, VERIFICATION_HTML

logger = logging.getLogger(__name__)
_RESEND_EMAILS_URL = "https://api.resend.com/emails"


@dataclass(frozen=True)
class _Message:
    """A rendered message, independent of how it gets delivered."""

    to: str
    subject: str
    html: str
    text: str


def _expiry_text(hours: int) -> str:
    unit = "hour" if hours == 1 else "hours"
    return f"This link expires in {hours} {unit}."


async def _deliver(message: _Message) -> None:
    """Send the message, or park it in the development outbox when email isn't configured.

    Rendering is deliberately kept out of here: every caller produces a complete `_Message`, so the
    outbox holds exactly what Resend would have been handed rather than a hand-assembled summary.
    """
    if settings.resend_api_key:
        try:
            await asyncio.to_thread(_call_resend, message)
        except RuntimeError:
            logger.exception("Failed to send %r to %s", message.subject, message.to)
        return

    if settings.environment is Environment.development:
        path = await asyncio.to_thread(
            write_dev_message,
            to=message.to,
            subject=message.subject,
            html=message.html,
            text=message.text,
        )
        # The path, never the body: these messages carry live account-takeover links.
        logger.info("Email is not configured; wrote %r for %s to %s", message.subject, message.to, path)
        return

    # Not development and no key: dropping mail silently would strand users mid-verification with
    # nothing in the record to explain it.
    logger.error("Email is not configured; dropped %r for %s", message.subject, message.to)


async def send_verification_email(email: str, verification_url: str) -> None:
    expiry = _expiry_text(settings.email_verification_expire_hours)
    await _deliver(
        _Message(
            to=email,
            subject="Verify your FrontDashboard email",
            html=Template(VERIFICATION_HTML).substitute(verification_url=verification_url, expiry_text=expiry),
            text=f"Welcome to FrontDashboard.\n\nVerify your email address here:\n{verification_url}\n\n{expiry}",
        )
    )


async def send_password_reset_email(email: str, reset_url: str) -> None:
    expiry = _expiry_text(settings.password_reset_expire_hours)
    await _deliver(
        _Message(
            to=email,
            subject="Reset your FrontDashboard password",
            html=Template(PASSWORD_RESET_HTML).substitute(reset_url=reset_url, expiry_text=expiry),
            text=(f"Reset your FrontDashboard password here:\n{reset_url}\n\n{expiry}\n\nIf you did not request this, you can ignore this email."),
        )
    )


async def send_existing_account_email(email: str) -> None:
    """Tell the address owner that a signup was attempted, since the API deliberately won't.

    Registration answers identically for known and unknown addresses (ADR-011), so this mail is
    the only place the "you already have an account" fact is ever revealed — to the one party
    entitled to it.
    """
    base = settings.frontend_base_url.rstrip("/")
    login_url = f"{base}/login"
    reset_url = f"{base}/forgot-password"
    await _deliver(
        _Message(
            to=email,
            subject="You already have a FrontDashboard account",
            html=Template(EXISTING_ACCOUNT_HTML).substitute(login_url=login_url, reset_url=reset_url),
            text=(
                "Someone just tried to sign up for FrontDashboard with this email address.\n\n"
                f"You already have an account, so no new one was created. Sign in here:\n{login_url}\n\n"
                f"Forgot your password? Reset it here:\n{reset_url}\n\n"
                "If this wasn't you, no action is needed."
            ),
        )
    )


def _call_resend(message: _Message) -> None:
    payload = {
        "from": settings.email_from,
        "to": [message.to],
        "subject": message.subject,
        "html": message.html,
        "text": message.text,
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
