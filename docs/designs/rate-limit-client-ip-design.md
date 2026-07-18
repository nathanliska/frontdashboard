# Design — Key rate limits on the real client IP (#15)

**Date:** 2026-07-18
**Status:** ◻ Planned.
**Finding:** #15 (rate limiting collapses to one global bucket behind the proxy), sharpened to **High**
by the 2026-07-17 Phase 2 security review.

## Theme

Production runs **Cloudflare Tunnel → Caddy (`:80`) → uvicorn** (`frontdashboard-backend:8000`).
uvicorn launches with no `--proxy-headers` (`backend/Dockerfile.prod`), so `request.client.host` is
Caddy's container IP for every request. The limiter keys on that via `get_remote_address`
(`backend/app/limiter.py`), collapsing every auth limit — `login 10/min`, `register 5/min`,
`password-reset/request` & `resend 3/min`, `refresh 30/min` — into **one global bucket**. A single
client sending 10 logins/min then locks out every other user, and the per-attacker brute-force /
enumeration isolation the auth hardening relies on does not exist.

## What is actually true today (verified in code)

- `backend/app/limiter.py` is `Limiter(key_func=get_remote_address)`.
- `get_remote_address` returns `request.client.host` — the immediate TCP peer, which is Caddy.
- Ingress is a **Cloudflare Tunnel** (confirmed with the maintainer): the origin is not publicly
  reachable; only Cloudflare can connect. Cloudflare sets `CF-Connecting-IP` to the real client IP,
  and Caddy forwards incoming headers to the backend by default.
- The limiter is active in tests; `conftest.py` resets `limiter._storage` between tests, so
  rate-limit behavior is testable in isolation. No existing 429 tests.

## Design

Replace the limiter's key function with one that prefers Cloudflare's `CF-Connecting-IP`, falling
back to the peer IP when the header is absent:

```python
# backend/app/limiter.py
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def client_ip_key(request: Request) -> str:
    # Behind the Cloudflare Tunnel, Cloudflare sets CF-Connecting-IP to the real client IP. The
    # origin is reachable only through the tunnel, so the header is authoritative and unspoofable.
    # Falls back to the peer address for local/dev where Cloudflare is not in front.
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    return cf_ip or get_remote_address(request)


limiter = Limiter(key_func=client_ip_key)
```

This is the entire production change — no router, Caddy, or Dockerfile edits. Header lookup is
case-insensitive (Starlette). A blank/whitespace header falls through to the peer IP. Because the
ingress is a tunnel, no "peer must be Cloudflare" validation is needed.

## Testing (pytest, Testcontainers)

- **Unit** (`test_limiter.py`): build a minimal request (or a small stub exposing `.headers` and
  `.client`) and assert `client_ip_key` returns the `CF-Connecting-IP` value (whitespace stripped)
  when present, and falls back to `get_remote_address` when the header is absent or blank.
- **Integration — bucket isolation (load-bearing):** against `POST /login` (10/min), send 10 requests
  with `CF-Connecting-IP: 1.1.1.1` (all `401`), assert the 11th is `429`; then send one request with
  `CF-Connecting-IP: 2.2.2.2` and assert it is **not** `429` (still `401` — its own bucket). This
  fails against today's code (all requests share the peer-IP bucket, so `2.2.2.2` also `429`s) and
  passes after the fix. Reset happens between tests via the existing conftest fixture.

## Out of scope / deferred

- **Multi-worker shared store (#45).** slowapi's default in-memory buckets are per-process, correct
  only with the current single worker. Running multiple workers would need a shared store (e.g.
  Redis) — tracked as #45, deferred.
- **Trust assumption.** This fix relies on the Cloudflare Tunnel keeping the origin non-public. If the
  deployment ever switches to an exposed origin (proxied DNS to a public port), `CF-Connecting-IP`
  becomes spoofable and the origin must additionally be restricted to Cloudflare IP ranges (a Caddy
  `@cloudflare` matcher or a host firewall). Recorded here so the assumption is explicit.

## Execution

Small enough to implement directly (one source file + one test file) with TDD, followed by a single
security-focused review pass before shipping.
