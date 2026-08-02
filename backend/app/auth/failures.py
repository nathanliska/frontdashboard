"""The one way to reject an authentication attempt.

Building the exception and counting it are the same call, so a rejection cannot be added without
its metric. `test_auth_failure_coverage.py` fails the build if the auth layer raises a bare 401/403.
"""

from fastapi import HTTPException

from app.metrics import AUTH_FAILURES


def auth_failure(operation: str, reason: str, *, status_code: int, detail: str) -> HTTPException:
    """Count a rejected attempt and return the exception to raise for it.

    Returns rather than raises so the call site keeps its own `raise`, which is what static
    analysis and a reader both follow.
    """
    AUTH_FAILURES.labels(operation=operation, reason=reason).inc()
    return HTTPException(status_code=status_code, detail=detail)
