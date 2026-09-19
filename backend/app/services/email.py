import asyncio
import html
import logging
from dataclasses import dataclass
from string import Template

import httpx

from app import metrics
from app.config import Environment, settings
from app.services.dev_mail import write_dev_message
from app.services.email_templates import EMAIL_CHANGE_LAYOUT_HTML, EXISTING_ACCOUNT_HTML, PASSWORD_RESET_HTML, VERIFICATION_HTML

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


async def _deliver(message: _Message, *, operation: metrics.EmailOperation) -> None:
    """Send the message, or park it in the development outbox when email isn't configured.

    Rendering is deliberately kept out of here: every caller produces a complete `_Message`, so the
    outbox holds exactly what Resend would have been handed rather than a hand-assembled summary.
    `operation` exists only to label the counter, since a failure here reaches nothing else.
    """
    if settings.resend_api_key:
        try:
            await _call_resend(message)
        except RuntimeError:
            metrics.EMAIL_SENDS.labels(operation=operation, outcome="failed").inc()
            logger.exception("Failed to send %r to %s", message.subject, message.to)
        else:
            metrics.EMAIL_SENDS.labels(operation=operation, outcome="sent").inc()
        return

    if settings.environment is Environment.development:
        path = await asyncio.to_thread(
            write_dev_message,
            to=message.to,
            subject=message.subject,
            html=message.html,
            text=message.text,
        )
        metrics.EMAIL_SENDS.labels(operation=operation, outcome="outbox").inc()
        # The path, never the body: these messages carry live account-takeover links.
        logger.info("Email is not configured; wrote %r for %s to %s", message.subject, message.to, path)
        return

    # Not development and no key: dropping mail silently would strand users mid-verification with
    # nothing in the record to explain it.
    metrics.EMAIL_SENDS.labels(operation=operation, outcome="dropped").inc()
    logger.error("Email is not configured; dropped %r for %s", message.subject, message.to)


async def send_verification_email(email: str, verification_url: str) -> None:
    expiry = _expiry_text(settings.email_verification_expire_hours)
    await _deliver(
        _Message(
            to=email,
            subject="Verify your FrontDashboard email",
            html=Template(VERIFICATION_HTML).substitute(verification_url=verification_url, expiry_text=expiry),
            text=f"Welcome to FrontDashboard.\n\nVerify your email address here:\n{verification_url}\n\n{expiry}",
        ),
        operation="verification",
    )


async def send_password_reset_email(email: str, reset_url: str) -> None:
    expiry = _expiry_text(settings.password_reset_expire_hours)
    await _deliver(
        _Message(
            to=email,
            subject="Reset your FrontDashboard password",
            html=Template(PASSWORD_RESET_HTML).substitute(reset_url=reset_url, expiry_text=expiry),
            text=(f"Reset your FrontDashboard password here:\n{reset_url}\n\n{expiry}\n\nIf you did not request this, you can ignore this email."),
        ),
        operation="password_reset",
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
        ),
        operation="existing_account",
    )


async def send_email_change_confirmation(new_email: str, confirm_url: str) -> None:
    expiry = _expiry_text(settings.email_change_expire_hours)
    lead = "Confirm that this is the new email address for your FrontDashboard account. Nothing changes until you do."
    aside = "If you did not ask for this, ignore this email and the address will not be used."
    await _deliver(
        _Message(
            to=new_email,
            subject="Confirm your new FrontDashboard email",
            html=Template(EMAIL_CHANGE_LAYOUT_HTML).substitute(
                title="Confirm your new email",
                lead=lead,
                action_url=confirm_url,
                action_label="Confirm email",
                expiry_text=expiry,
                aside=aside,
                reason="You received this because this address was entered as the new email for an account.",
            ),
            text=f"{lead}\n\n{confirm_url}\n\n{expiry}\n\n{aside}",
        ),
        operation="email_change",
    )


async def send_email_change_notice(old_email: str, new_email: str) -> None:
    """Warn the current address that a change is pending, and say how to stop it.

    The only takeover signal the account's owner gets, since the old address is not asked to
    confirm (FDR-001 §8). `new_email` is whatever the requester typed, so it is escaped.
    """
    reset_url = f"{settings.frontend_base_url.rstrip('/')}/forgot-password"
    lead = f"Someone signed in to your FrontDashboard account asked to change its email address to {new_email}."
    aside = "It takes effect only once that address confirms it. If this was you, no action is needed."
    stop = "If it was not you, reset your password now. Until the change is confirmed, that cancels it and signs out every device."
    await _deliver(
        _Message(
            to=old_email,
            subject="A change to your FrontDashboard email was requested",
            html=Template(EMAIL_CHANGE_LAYOUT_HTML).substitute(
                title="Email change requested",
                lead=f"{html.escape(lead)} {stop}",
                action_url=reset_url,
                action_label="Reset password",
                expiry_text="",
                aside=aside,
                reason="You received this because this is the current email address of the account.",
            ),
            text=f"{lead}\n\n{aside}\n\n{stop}\n{reset_url}",
        ),
        operation="email_change_notice",
    )


async def _call_resend(message: _Message) -> None:
    """Post one message to Resend, normalising every failure to RuntimeError for `_deliver`.

    A client per call rather than a pooled one: these sends are rare enough that a connection to
    keep alive would idle out between them, and pooling would owe the lifespan a close.
    """
    payload = {
        "from": settings.email_from,
        "to": [message.to],
        "subject": message.subject,
        "html": message.html,
        "text": message.text,
    }
    headers = {
        "Authorization": f"Bearer {settings.resend_api_key}",
        "User-Agent": "frontdashboard/0.1",
    }
    try:
        # Stated because urllib followed redirects and httpx does not: a redirected POST would
        # re-send the message to whatever answered, and this endpoint is fixed.
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            response = await client.post(_RESEND_EMAILS_URL, json=payload, headers=headers)
            response.raise_for_status()
    # Before the base class, which this one inherits from.
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        status = exc.response.status_code
        raise RuntimeError(f"Resend email request failed with status {status}: {detail}") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Resend email request failed: {exc}") from exc
