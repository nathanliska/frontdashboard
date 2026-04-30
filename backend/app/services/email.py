import asyncio
import json
import logging
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from app.config import settings

logger = logging.getLogger(__name__)
_RESEND_EMAILS_URL = "https://api.resend.com/emails"


async def send_verification_email(email: str, verification_url: str) -> None:
    if not settings.resend_api_key:
        logger.debug("Email verification link for %s: %s", email, verification_url)
        return

    await asyncio.to_thread(_send_resend_email, email, verification_url)


def _send_resend_email(email: str, verification_url: str) -> None:
    payload = {
        "from": settings.email_from,
        "to": [email],
        "subject": "Verify your FrontDashboard email",
        "text": (f"Welcome to FrontDashboard.\n\nVerify your email address here:\n{verification_url}\n\nThis link expires soon."),
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
