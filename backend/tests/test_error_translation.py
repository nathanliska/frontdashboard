"""The global IntegrityError -> 409 translation (finding #26).

Every write is schema-validated before it reaches the database, so a constraint violation that
escapes route-level handling means two requests disagreed about current state — a conflict the
client can resolve by refetching, not a server error it can only stare at.
"""

import json
import logging

from fastapi import Request
from sqlalchemy.exc import IntegrityError

from app.main import handle_integrity_error


def _request() -> Request:
    return Request(scope={"type": "http", "method": "POST", "path": "/api/example", "headers": [], "query_string": b""})


async def test_integrity_errors_become_conflicts(caplog) -> None:
    exc = IntegrityError("INSERT ...", {}, Exception("duplicate key"))

    app_logger = logging.getLogger("app")
    original_propagate = app_logger.propagate
    app_logger.propagate = True
    try:
        with caplog.at_level(logging.ERROR, logger="app"):
            response = await handle_integrity_error(_request(), exc)
    finally:
        app_logger.propagate = original_propagate

    assert response.status_code == 409
    body = json.loads(bytes(response.body))
    # The shape every client error path expects ({"detail": ...}), with retry guidance.
    assert "detail" in body
    assert "try again" in body["detail"].lower()

    # Logged with the traceback: a route that hits this repeatedly deserves a targeted handler.
    assert "IntegrityError escaped route handling" in caplog.text
    assert "/api/example" in caplog.text
