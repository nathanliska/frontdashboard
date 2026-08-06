"""Delivery-path tests for outgoing mail (finding #42).

The property under test is not "does mail send" but "where does a live credential end up". A
verification or reset URL is a bearer credential for the account, so the interesting assertions are
negative: it must not reach the log stream, and it must not be written anywhere outside development.
"""

import logging
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from app.config import Environment
from app.services import email as email_service
from app.services.dev_mail import write_dev_message

_RESET_URL = "http://localhost:5173/reset-password?token=super-secret-raw-token"


@pytest.fixture
def outbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    directory = tmp_path / "dev-mail"
    monkeypatch.setattr(email_service.settings, "dev_mail_dir", str(directory))
    monkeypatch.setattr(email_service.settings, "resend_api_key", None)
    return directory


@pytest.fixture
def logs(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.LogCaptureFixture]:
    """Capture records from the "app" logger tree.

    `caplog` listens at the root, but `app.main` sets `propagate = False` on "app" so application
    output goes through its own handler. Once anything has imported `app.main` — which the rest of
    the suite does — a plain `caplog` here captures nothing. These tests are about what does and
    does not reach the log, so an empty capture would make every negative assertion vacuous.
    """
    monkeypatch.setattr(logging.getLogger("app"), "propagate", True)
    with caplog.at_level(logging.DEBUG, logger="app"):
        yield caplog


async def test_development_writes_the_message_to_the_outbox(outbox: Path, monkeypatch: pytest.MonkeyPatch, logs: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(email_service.settings, "environment", Environment.development)

    await email_service.send_password_reset_email("user@example.com", _RESET_URL)

    written = sorted(outbox.glob("*.txt"))
    assert len(written) == 1
    body = written[0].read_text(encoding="utf-8")
    assert _RESET_URL in body
    assert "user@example.com" in body
    # The HTML part lands alongside it so a template can be opened in a browser.
    assert written[0].with_suffix(".html").exists()

    # The whole point: the credential is in the file, and only the file is named in the log.
    assert _RESET_URL not in logs.text
    assert str(written[0]) in logs.text


async def test_non_development_drops_the_mail_without_logging_the_link(
    outbox: Path, monkeypatch: pytest.MonkeyPatch, logs: pytest.LogCaptureFixture
) -> None:
    """An absent API key is the default, so it must not be what enables credential printing."""
    monkeypatch.setattr(email_service.settings, "environment", Environment.test)

    await email_service.send_password_reset_email("user@example.com", _RESET_URL)

    assert not outbox.exists()
    assert _RESET_URL not in logs.text
    assert "dropped" in logs.text


async def test_a_configured_key_sends_and_writes_nothing_locally(outbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(email_service.settings, "environment", Environment.development)
    monkeypatch.setattr(email_service.settings, "resend_api_key", "re_test_key")
    sent: list[email_service._Message] = []

    async def _record(message: email_service._Message) -> None:
        sent.append(message)

    monkeypatch.setattr(email_service, "_call_resend", _record)

    await email_service.send_password_reset_email("user@example.com", _RESET_URL)

    assert len(sent) == 1
    assert sent[0].to == "user@example.com"
    assert _RESET_URL in sent[0].text
    assert _RESET_URL in sent[0].html
    assert not outbox.exists()


async def test_send_failures_are_logged_without_the_link(outbox: Path, monkeypatch: pytest.MonkeyPatch, logs: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(email_service.settings, "environment", Environment.development)
    monkeypatch.setattr(email_service.settings, "resend_api_key", "re_test_key")

    async def _fail(message: email_service._Message) -> None:
        raise RuntimeError("Resend email request failed: unreachable")

    monkeypatch.setattr(email_service, "_call_resend", _fail)

    await email_service.send_password_reset_email("user@example.com", _RESET_URL)

    assert "Failed to send" in logs.text
    assert _RESET_URL not in logs.text


def _resend_returning(handler, monkeypatch: pytest.MonkeyPatch) -> None:
    """Route `_call_resend`'s client at a mock transport, leaving its own construction intact."""
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=transport, **kw))


async def test_a_rejected_send_carries_the_status_and_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_deliver` only distinguishes RuntimeError, so everything below has to normalise to one.

    The status and body are the whole diagnostic — an invalid API key reaches the operator as a 401
    and Resend's own wording, or not at all.
    """
    monkeypatch.setattr(email_service.settings, "resend_api_key", "re_test_key")
    _resend_returning(lambda _req: httpx.Response(401, json={"message": "API key is invalid"}), monkeypatch)
    message = email_service._Message(to="user@example.com", subject="s", html="h", text="t")

    with pytest.raises(RuntimeError) as excinfo:
        await email_service._call_resend(message)

    assert "401" in str(excinfo.value)
    assert "API key is invalid" in str(excinfo.value)


async def test_an_unreachable_resend_is_the_same_kind_of_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A transport error and a rejection differ by class, and `_deliver` handles neither specially."""

    def _refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    monkeypatch.setattr(email_service.settings, "resend_api_key", "re_test_key")
    _resend_returning(_refuse, monkeypatch)
    message = email_service._Message(to="user@example.com", subject="s", html="h", text="t")

    with pytest.raises(RuntimeError):
        await email_service._call_resend(message)


async def test_a_send_posts_the_message_as_json_under_the_bearer_key(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[httpx.Request] = []

    def _accept(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "abc"})

    monkeypatch.setattr(email_service.settings, "resend_api_key", "re_test_key")
    _resend_returning(_accept, monkeypatch)
    message = email_service._Message(to="user@example.com", subject="s", html="<p>h</p>", text="t")

    await email_service._call_resend(message)

    assert seen[0].headers["authorization"] == "Bearer re_test_key"
    assert seen[0].headers["content-type"] == "application/json"
    assert b'"to":["user@example.com"]' in seen[0].content


def test_the_outbox_keeps_only_the_most_recent_messages(outbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise a long-running dev environment accumulates live credentials indefinitely."""
    # `settings` is one shared object, so the `outbox` fixture already redirected dev_mail too.
    monkeypatch.setattr("app.services.dev_mail._KEEP_MESSAGES", 3)

    for index in range(5):
        write_dev_message(to="user@example.com", subject=f"Message {index}", html="<p>x</p>", text="x")

    remaining = sorted(path.read_text(encoding="utf-8") for path in outbox.glob("*.txt"))
    assert len(remaining) == 3
    assert len(list(outbox.glob("*.html"))) == 3
    # The newest survive, not an arbitrary three.
    assert all(f"Message {index}" in "".join(remaining) for index in (2, 3, 4))
