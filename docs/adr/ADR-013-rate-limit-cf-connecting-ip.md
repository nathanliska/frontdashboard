# ADR-013: Rate Limiting — Per-Route Limits Keyed on `CF-Connecting-IP`

**Date:** 2026-07-20 (amended 2026-07-30: limits extended to every mutating route)

## Context

Auth endpoints are rate-limited to blunt brute force. A rate limiter must key on the *real* client,
but the backend never sees the client directly: production traffic arrives through a **non-public
Cloudflare Tunnel**, so the peer address the app observes is the tunnel/proxy, not the user. Keying
on the observed peer address would collapse every client into one shared bucket — either locking
everyone out together or, more likely, making per-client limits meaningless.

## Decision

Key the limiter on **`CF-Connecting-IP`**, the real client IP that Cloudflare sets, falling back to
the peer address in development (where there's no Cloudflare in front).

Because the origin is a **non-public Cloudflare Tunnel**, `CF-Connecting-IP` is authoritative here —
a client can't reach the origin directly to spoof the header, since the only path in is through
Cloudflare. The header is honored **only when the peer is private or loopback**; a public peer
means the request bypassed the tunnel, so its header is attacker-controlled and is ignored.

Every mutating route additionally carries **`@limiter.limit(WRITE_LIMIT)` applied per route**, not
an application-wide default. slowapi's app-wide limit runs in middleware that resolves handlers
through `app.routes`, which cannot see through this FastAPI version's included-router nesting — so
it silently exempts everything. Per-route decoration is the only form that actually applies, and
`test_rate_limit_coverage.py` fails the build when a mutating route is added without one.

## Consequences

- **Per-client auth limits actually isolate**: each real client gets its own bucket instead of
  sharing the proxy's, so one abuser's attempts don't consume everyone's budget (and vice versa).
- **Trusting the header is safe *only* because of the tunnel topology**: this decision depends on the
  origin being unreachable except through Cloudflare. If the origin were ever exposed directly, the
  header would become spoofable and this keying would be unsafe.
- **Dev parity via fallback**: local development, with no Cloudflare, falls back to the peer address
  so the limiter still works without special-casing.
- **Rate is bounded; volume is not.** `WRITE_LIMIT` is generous on purpose — the key is a client IP
  a whole household shares behind one NAT — so it stops a runaway client or a crude script, not a
  patient one. Total storage per account needs a quota, which is a separate open finding (#61).
- **A forgotten decorator is a build failure, not a silent hole**, because the coverage test
  enumerates mutating routes rather than trusting review. Note the same nesting quirk defeats any
  audit written over `app.routes`, which sees four docs routes and one `_IncludedRouter`.
- **Buckets are in-memory/per-process**: correct for the current single worker; N workers would mean
  N× every limit — degraded rather than broken, unlike SSE fan-out under the same change
  ([ADR-004](ADR-004-sse-over-websocket.md)). slowapi's `Limiter` accepts a `storage_uri`, so
  adopting a shared store is a one-line change and is deliberately *not* pre-built as configuration
  nothing reads (#21/#45 in [TODO.md](../TODO.md)).
