"""The resend and reset routes answer before any account-dependent work runs (FDR-001 §11)."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy import event

from app import metrics
from app.routers import auth as auth_router
from app.services import auth_email
from tests.conftest import _TestDatabase
from tests.helpers import register_user

_ROUTES = {
    "resend": ("/api/auth/resend-verification", "resend_verification_link"),
    "reset": ("/api/auth/password-reset/request", "issue_password_reset_link"),
}


def _deferred_failures(operation: str) -> float:
    for metric in metrics.AUTH_DEFERRED_FAILURES.collect():
        for sample in metric.samples:
            if sample.name.endswith("_total") and sample.labels == {"operation": operation}:
                return sample.value
    return 0.0


@pytest.mark.parametrize("known", [True, False], ids=["known", "unknown"])
@pytest.mark.parametrize("route", list(_ROUTES))
async def test_the_route_runs_no_sql_and_hands_the_address_to_the_deferred_unit(
    db_client: AsyncClient, test_database: _TestDatabase, monkeypatch: pytest.MonkeyPatch, route: str, known: bool
) -> None:
    """A statement inside the request would run only for one of the two addresses, and its timing would say which."""
    path, unit = _ROUTES[route]
    email = "testuser@example.com" if known else "nobody@example.com"
    spy = AsyncMock()
    monkeypatch.setattr(auth_router, unit, spy)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany) -> None:  # noqa: ANN001
        statements.append(statement)

    event.listen(test_database.engine.sync_engine, "before_cursor_execute", record)
    try:
        # Registering is the positive control: an empty list is also what a dead listener records.
        await register_user(db_client, "testuser@example.com")
        assert statements
        statements.clear()
        db_client.cookies.clear()
        resp = await db_client.post(path, json={"email": email})
    finally:
        event.remove(test_database.engine.sync_engine, "before_cursor_execute", record)

    assert resp.status_code == 204
    assert statements == []
    spy.assert_awaited_once_with(email)


@pytest.mark.parametrize("unit", ["resend_verification_link", "issue_password_reset_link"])
async def test_a_failing_unit_is_counted_and_logged_not_raised(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, unit: str) -> None:
    """The request is already answered, so the counter and the log are the only places a failure can go."""
    operation = "verification_resend" if unit == "resend_verification_link" else "password_reset"

    @asynccontextmanager
    async def _unreachable_database():
        raise RuntimeError("database down")
        yield

    monkeypatch.setattr(auth_email, "async_session_factory", _unreachable_database)
    before = _deferred_failures(operation)

    await getattr(auth_email, unit)("someone@example.com")

    assert _deferred_failures(operation) == before + 1
    assert "database down" in caplog.text
