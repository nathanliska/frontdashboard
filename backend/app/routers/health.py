"""Health check endpoints for liveness probes and local smoke tests."""

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
async def health() -> dict:
    """Return a minimal success payload when the app is reachable."""
    return {"status": "ok"}
