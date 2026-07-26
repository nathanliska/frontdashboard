"""Development-only mail sink.

Verification and password-reset links are bearer credentials: whoever holds one takes the account.
Locally there has to be *some* way to get at them, but the application log is the wrong place — it
is the stream that gets tailed on a screen share, pasted into an issue, and shipped wherever
container output goes. So development writes the whole rendered message to a gitignored outbox and
the log only ever names the file.

The sink is gated on ``ENVIRONMENT=development`` rather than on the API key being absent. An absent
key is the *default*, so keying off it would make "print account-takeover credentials" the fallback
behavior of any misconfigured deployment. Production already refuses to start without a key
(``config.Settings._validate_production_security``); this is the second lock on that door, in the
one place that would do the printing.
"""

import re
from datetime import UTC, datetime
from pathlib import Path

from app.config import settings

# Enough to check the last few flows by hand; past that the outbox is just accumulating credentials.
_KEEP_MESSAGES = 50
_SLUG_UNSAFE = re.compile(r"[^a-z0-9]+")


def _slug(subject: str) -> str:
    return _SLUG_UNSAFE.sub("-", subject.lower()).strip("-")[:48] or "message"


def _prune(outbox: Path) -> None:
    stale = sorted(outbox.glob("*.txt"))[:-_KEEP_MESSAGES]
    for path in stale:
        path.with_suffix(".html").unlink(missing_ok=True)
        path.unlink(missing_ok=True)


def write_dev_message(*, to: str, subject: str, html: str, text: str) -> Path:
    """Write a rendered message to the local outbox and return the path of its text part.

    Both parts land side by side: the ``.txt`` carries the link in a form you can grep or click
    from a terminal, the ``.html`` is openable in a browser when the template itself is what you
    are checking.
    """
    outbox = Path(settings.dev_mail_dir)
    outbox.mkdir(parents=True, exist_ok=True)

    # Sorts chronologically as a plain string, which is what _prune relies on.
    stem = f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%f')}-{_slug(subject)}"
    (outbox / f"{stem}.html").write_text(html, encoding="utf-8")
    path = outbox / f"{stem}.txt"
    path.write_text(f"To: {to}\nSubject: {subject}\n\n{text}\n", encoding="utf-8")

    _prune(outbox)
    return path
