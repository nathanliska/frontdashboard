from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def client_ip_key(request: Request) -> str:
    # Behind the Cloudflare Tunnel, Cloudflare sets CF-Connecting-IP to the real client IP. The
    # origin is reachable only through the tunnel, so the header is authoritative and unspoofable.
    # Falls back to the peer address for local/dev where Cloudflare is not in front (finding #15).
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    return cf_ip or get_remote_address(request)


limiter = Limiter(key_func=client_ip_key)
