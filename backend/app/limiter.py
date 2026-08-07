import ipaddress
from typing import Any

from fastapi import Request
from redis.backoff import NoBackoff
from redis.retry import Retry
from slowapi import Limiter
from slowapi.util import get_remote_address

from app import metrics
from app.config import settings


def _peer_is_trusted(request: Request) -> bool:
    # Only our own infrastructure may assert the client IP: Caddy on the Docker network in prod,
    # loopback in dev. A public peer bypassed the tunnel, so its CF-Connecting-IP is forgeable.
    peer = request.client.host if request.client else None
    if not peer:
        return False
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def client_ip_key(request: Request) -> str:
    # Authoritative only through our proxy chain (ADR-013); anything else keys on the peer address.
    if _peer_is_trusted(request):
        cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
        if cf_ip:
            return cf_ip
    return get_remote_address(request)


# Bounded so an outage costs a stall rather than seconds: redis-py defaults to ten attempts with
# exponential backoff, which turns this connect ceiling into 5s on every write until the per-process
# fallback takes over. ADR-013 has why that fallback, rather than 500ing or letting writes through.
STORAGE_OPTIONS: dict[str, Any] = {
    "socket_connect_timeout": 0.25,
    "socket_timeout": 0.25,
    "retry": Retry(NoBackoff(), 1),
}

limiter = Limiter(
    key_func=client_ip_key,
    storage_uri=settings.redis_url,
    # `limits` keys every app it serves identically, so this is what keeps a REDIS_URL overridden to
    # a shared instance from colliding — with another app, and with another environment of this one,
    # whose traffic would otherwise spend the same client's budget. The bundled instance is alone.
    key_prefix=f"frontdashboard:{settings.environment.value}",
    # slowapi annotates this `dict[str, str]`, but the values reach redis-py, which raises
    # TypeError on a string timeout. Floats are what work.
    storage_options=STORAGE_OPTIONS,
    in_memory_fallback_enabled=True,
)

# slowapi only re-checks the store when a limited request arrives, so this reports last-known state
# rather than live truth: with no writes it stays 1 until one comes. `test_limiter_fallback.py`
# pins the attribute, which is private and would otherwise be renamed by an upgrade in silence.
metrics.register_gauge(
    "rate_limit_store_degraded",
    "1 while limits are enforced per process because the shared store is unreachable.",
    lambda: float(limiter._storage_dead),
)

# Applied per route because slowapi's app-wide limit cannot see through included-router nesting and
# silently exempts everything; `test_rate_limit_coverage.py` catches a forgotten decorator. Generous
# because the key is a client IP a whole household shares — it bounds runaway clients, not abuse.
WRITE_LIMIT = "300/minute"
