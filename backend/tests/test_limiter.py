from fastapi import Request
from httpx import AsyncClient

from app.limiter import client_ip_key

_LOGIN_URL = "/api/auth/login"


def _request(headers: dict[str, str], client_host: str = "10.0.0.1") -> Request:
    scope = {
        "type": "http",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (client_host, 12345),
    }
    return Request(scope)


def test_client_ip_key_prefers_cf_connecting_ip() -> None:
    assert client_ip_key(_request({"CF-Connecting-IP": "203.0.113.7"})) == "203.0.113.7"


def test_client_ip_key_strips_whitespace() -> None:
    assert client_ip_key(_request({"CF-Connecting-IP": "  203.0.113.7  "})) == "203.0.113.7"


def test_client_ip_key_falls_back_to_peer_when_absent() -> None:
    assert client_ip_key(_request({}, client_host="198.51.100.4")) == "198.51.100.4"


def test_client_ip_key_falls_back_when_blank() -> None:
    assert client_ip_key(_request({"CF-Connecting-IP": "   "}, client_host="198.51.100.4")) == "198.51.100.4"


def test_client_ip_key_ignores_cf_header_from_untrusted_public_peer() -> None:
    # A request that reached the origin from a public peer (i.e. outside the Cloudflare Tunnel) must
    # not be able to assert its own rate-limit bucket via a forged CF-Connecting-IP. 8.8.8.8 is a
    # genuinely globally-routable address (not private/loopback/documentation).
    req = _request({"CF-Connecting-IP": "1.1.1.1"}, client_host="8.8.8.8")
    assert client_ip_key(req) == "8.8.8.8"


async def test_rate_limit_buckets_are_per_client_ip(db_client: AsyncClient) -> None:
    body = {"email": "nobody@example.com", "password": "whatever-passphrase-1"}

    # login is 10/minute: ten attempts from one client IP are allowed (401), the eleventh is blocked.
    for _ in range(10):
        allowed = await db_client.post(_LOGIN_URL, json=body, headers={"CF-Connecting-IP": "1.1.1.1"})
        assert allowed.status_code == 401
    blocked = await db_client.post(_LOGIN_URL, json=body, headers={"CF-Connecting-IP": "1.1.1.1"})
    assert blocked.status_code == 429

    # A different client IP has its own bucket and is not rate limited by the first IP's traffic.
    other = await db_client.post(_LOGIN_URL, json=body, headers={"CF-Connecting-IP": "2.2.2.2"})
    assert other.status_code == 401
