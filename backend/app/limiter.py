import ipaddress

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


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


limiter = Limiter(key_func=client_ip_key)

# Applied per route because slowapi's app-wide limit cannot see through included-router nesting and
# silently exempts everything; `test_rate_limit_coverage.py` catches a forgotten decorator. Generous
# because the key is a client IP a whole household shares — it bounds runaway clients, not abuse.
WRITE_LIMIT = "300/minute"
