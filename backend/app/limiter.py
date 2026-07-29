import ipaddress

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def _peer_is_trusted(request: Request) -> bool:
    # Only infrastructure inside our network may assert the client IP via CF-Connecting-IP: in prod
    # the peer is Caddy on the Docker network (a private address), in dev it is loopback. A public
    # peer means the request reached the origin outside the Cloudflare Tunnel, so its CF-Connecting-IP
    # is attacker-controlled and must not be honored (it would let a client pick its own bucket).
    peer = request.client.host if request.client else None
    if not peer:
        return False
    try:
        ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def client_ip_key(request: Request) -> str:
    # Behind the Cloudflare Tunnel, Cloudflare sets CF-Connecting-IP to the real client IP and the
    # origin is reachable only through the tunnel, so the header is authoritative — but only when the
    # request actually came through our proxy chain (see _peer_is_trusted). Falls back to the peer
    # address for local/dev and for any request that did not transit the trusted proxy (finding #15).
    if _peer_is_trusted(request):
        cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
        if cf_ip:
            return cf_ip
    return get_remote_address(request)


limiter = Limiter(key_func=client_ip_key)

# Every authenticated write carries this, per route: slowapi's application-wide limit runs in a
# middleware that resolves handlers through `app.routes`, which cannot see through this FastAPI
# version's included-router nesting, so it exempts everything. `test_rate_limit_coverage.py` keeps
# the decorator from being forgotten.
#
# Generous on purpose — the key is the client IP and a household behind one NAT shares it, so the
# ceiling has to sit far above a family working through a list together. It bounds a runaway client
# or a crude script, not storage abuse: a patient attacker stays under it forever (TODO #61).
WRITE_LIMIT = "300/minute"
