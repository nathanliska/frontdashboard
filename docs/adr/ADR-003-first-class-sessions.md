# ADR-003: First-Class Sessions with Immediate Revocation

**Date:** 2026-07-20
**Amended:** 2026-07-28 — the JWT access/refresh split was removed. The decision under it stands.

## Context

A stateless JWT is valid until it expires. That's fine until you need to *revoke* — log out one
device, cut off a stolen session, or invalidate other sessions on password change. With a purely
stateless token there's no server-side handle to revoke, so the token stays valid until expiry.

We need immediate, per-login revocation.

The original decision kept the cookie-JWT transport (ADR-002) and layered first-class sessions
underneath it: a short access JWT carrying `sid`, a longer rotating refresh token, and a
session-liveness check on every request. **That check is what made revocation immediate — and it is
also what made the token layer above it redundant.** A short access-token lifetime exists to bound
the damage of a credential that *cannot* be revoked; once every request resolves the session against
the database, the clock bounds nothing the lookup does not. The access and refresh cookies were both
`HttpOnly`, `Secure`, `SameSite=Lax`, same origin, same path — no disclosure vector separates them,
so "the access token is short-lived" protected against nothing the refresh cookie didn't hand over
anyway.

What the split cost was concrete. It obliged the client to land a successful `/auth/refresh` call on
a fixed interval, forever, and that recurring mandatory round trip is exactly what a deploy, a
tunnel restart, or a proxy 502 lands on. Reuse detection then turned a *lost response* into a
session revocation, because a client that never received its rotated cookie retries with a token the
server has already spent. Both failure modes were observed in production on 2026-07-28.

## Decision

Sessions are **first-class and the only credential**: one `sessions` row per login, holding a
SHA-256 hash of an opaque 256-bit token. The raw token is the `session` cookie (`HttpOnly`,
`Secure`, `SameSite=Lax`), and **every request resolves it against the row**, so revocation takes
effect on the next request.

- **One credential, not two.** No access JWT, no refresh token, no rotation, no reuse detection, no
  `/auth/refresh`. The per-request lookup was already being paid; it is now the whole mechanism.
- **Two timeouts, both enforced server-side** (OWASP Session Management): an **idle** bound on
  `last_used_at`, and an **absolute** bound on `expires_at` fixed at login and never extended. The
  previous model had only a sliding idle bound, so an actively used session never expired at all.
- `last_used_at` is bumped on a throttle, not on every request — sliding expiry must not cost a
  write per read.
- Password **change** revokes every *other* session and keeps the current one; **reset** and
  **logout** revoke accordingly. Mutating routes stay CSRF-guarded by the double-submit cookie,
  which is unchanged.
- SSE streams re-validate their session every 30s and end when it is revoked; revocation also drops
  in-process streams immediately as a latency optimisation (see ADR-004 / ADR-015).
- `sessions` has `ip_hash`, `user_agent_hash` and `device_name` columns, and **nothing writes
  them.** They are left unpopulated on purpose: there is no session-management UI to read them, so
  filling them would mean collecting client IPs for no one to look at. A plain SHA-256 of an IPv4
  is brute-forceable in seconds, so populating `ip_hash` also needs a keyed hash to be worth the
  name. Both are deferred to whoever builds that UI (#60).

## Consequences

- **Revocation is immediate for requests, ≤30s for streams** — unchanged, and now the only
  mechanism rather than one of two.
- **A DB read per request**: every authenticated request pays a session-liveness lookup. Acceptable
  at household scale; it's the price of statefulness. This did not change — it was always being
  paid, which is precisely why the token layer above it could go.
- **No theft detection.** Rotation was the only mechanism that would ever signal a copied cookie,
  and nothing replaces it. A deliberate trade: the tripwire fired on lost responses — a hard logout
  for an honest client — far more readily than it would fire on a real thief, given the cookie is
  `HttpOnly` and unreadable by script. The compensating controls are the absolute timeout and
  server-side revocation. That is a genuinely weaker position against a stolen cookie, and the
  honest mitigation is a session-management UI (#60), not the unpopulated columns above.
- **A transient network failure can no longer sign anyone out**, because there is no periodic
  re-auth call left to fail. The client still separates `401`/`403` (logged out) from `5xx`,
  timeouts and network errors (transient, retried), but that classification is no longer
  load-bearing.
- **`SECRET_KEY` loses its only consumer** and is dropped from configuration.
- **Every live session died at cutover.** Existing cookies carry no `token_hash`, so they cannot be
  migrated; every user re-authenticates once.
