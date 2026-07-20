# FDR-001: Authentication & Sessions

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

The account and session system: how a user registers, verifies their email, logs in, stays logged
in across a browser, and gets logged out. It exists to give a self-hosted household a real
multi-user account model with immediate, per-device session control — not just a shared password.

## Behavior

- **Registration → email verification → login.** A new user registers, receives a verification
  email, and must verify before they can log in. Registration also creates a default "My Dashboard".
- **Email identity is case-insensitive.** Addresses are normalized (trim + lowercase) at the API
  boundary, so casing can't create duplicate accounts or block login. Display names are trimmed,
  non-empty, and ≤100 characters.
- **Login is uniform on failure.** A wrong password and an unknown account return the same 401, with
  no observable timing difference.
- **Sessions are per-login and revocable.** Each login is its own session. Logging out ends that
  session immediately. Changing your password ends every *other* session but keeps the one you're
  using; a password reset ends sessions accordingly.
- **Staying logged in is seamless.** Access renews silently in the background; multiple tabs stay
  logged in together. A session that's been revoked stops working within seconds, including its live
  event stream.
- **Password reset and change.** Reset via emailed link; authenticated users can change their
  password or rename their profile.
- **Emails.** Verification and reset emails send in the background via Resend; without an API key the
  link is logged (how you get tokens in local dev).
- **Profile page.** Display name, password change, and home-dashboard preference.

## Design Decisions

### 1. Tokens live in HttpOnly cookies with CSRF double-submit

**Decision:** Access and refresh JWTs are stored in HttpOnly cookies; non-GET requests carry a
double-submit CSRF token.
**Why:** Keeps the session credential unreadable by JavaScript (XSS can't steal it) while defending
the automatic cookie send against CSRF. See ADR-002.
**Tradeoff:** Every mutating route must opt into the CSRF dependency, and the JWT's embedded `email`
means identity-changing routes must re-issue the cookie.

### 2. Sessions are first-class rows, checked every request

**Decision:** One `sessions` row per login, its `sid` embedded in the access JWT; every request
verifies the session is live.
**Why:** Stateless JWTs can't be revoked before expiry. A server-side session handle makes logout and
password-change revocation take effect immediately. See ADR-003.
**Tradeoff:** A session-liveness read on every authenticated request.

### 3. Refresh tokens rotate single-use with a grace window

**Decision:** Refresh tokens are single-use and rotating, consumed atomically with a 10-second grace
window; replay after the window revokes the session as suspected reuse.
**Why:** Rotation limits the value of a stolen refresh token; the grace window keeps racing tabs
(sharing one cookie) from logging each other out. See ADR-003.
**Tradeoff:** A spurious late replay can trip the reuse tripwire and force a re-login.

### 4. Login is enumeration-safe and constant-work

**Decision:** Login always performs exactly one Argon2 verify (against a fixed dummy hash for unknown
emails) and returns an identical 401 for missing-account and wrong-password.
**Why:** Removes both the response and timing oracles that would reveal which accounts exist. See
ADR-011.
**Tradeoff:** Every login pays a full Argon2 verify, even for nonexistent accounts. Register-time
enumeration is separately accepted as a deliberate household-scale risk.

### 5. Argon2 runs off the event loop under a bounded limiter

**Decision:** Password hashing runs in a worker thread under a shared capacity limiter
(`argon2_max_concurrency`, default 4).
**Why:** Keeps a login burst from stalling the async event loop and bounds Argon2's memory cost. See
ADR-010.
**Tradeoff:** Under heavy burst, logins queue on the limiter and add latency.

### 6. Client state is wiped and generation-guarded at every auth boundary

**Decision:** Login, logout, verification, and unauthenticated startup clear all client state; a
session-generation counter drops any in-flight async write whose boundary has since been crossed.
**Why:** Prevents one account's cached or in-flight data from leaking into the next account in the
same tab. See ADR-012.
**Tradeoff:** Every account-scoped store must adopt the generation-guard pattern and a reset hook.

## Access

Authentication *is* the access boundary for the account itself. Resource-level access (owner /
editor / viewer) is covered in [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-002 (JWT cookies + CSRF), ADR-003 (first-class sessions), ADR-010 (Argon2 off the
  event loop), ADR-011 (enumeration-safe login), ADR-012 (session-generation guard), ADR-013 (rate
  limiting), ADR-014 (fail-fast prod config)
- **FDRs:** FDR-004 (Sharing & Access), FDR-008 (Real-Time Delivery)
