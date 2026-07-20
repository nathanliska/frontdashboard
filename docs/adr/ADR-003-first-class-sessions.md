# ADR-003: First-Class Sessions with Immediate Revocation

**Date:** 2026-07-20

## Context

A stateless JWT is valid until it expires. That's fine until you need to *revoke* — log out one
device, cut off a stolen session, or invalidate other sessions on password change. With a purely
stateless token there's no server-side handle to revoke, so the token stays valid until expiry.

We need immediate, per-login revocation without abandoning the cookie-JWT transport (ADR-002).

## Decision

Make sessions **first-class**: one `sessions` row per login, stable across refresh rotation. The
access JWT embeds its session id (`sid`), and **every request checks the session is still live**, so
revocation takes effect on the next request.

- Access tokens are short (15 min); refresh tokens are longer (7d), **single-use and rotating**.
- Refresh rotation consumes the old token atomically with a **10-second grace window** so racing
  tabs (which share one cookie and expire together) both survive; a replay *after* the window is
  treated as token reuse and revokes the session.
- Password **change** revokes every *other* session and keeps the current one; **reset** and
  **logout** revoke accordingly. `/auth/refresh` is CSRF-guarded and rate-limited.
- SSE streams re-validate their session every 30s and end when it is revoked; revocation also drops
  in-process streams immediately as a latency optimisation (see ADR-004 / ADR-015).

## Consequences

- **Revocation is immediate for requests, ≤30s for streams**: the per-request check gates every
  mutation and fetch the instant a session dies; long-lived SSE connections close within one
  revalidation interval.
- **A DB read per request**: every authenticated request pays a session-liveness lookup. Acceptable
  at household scale; it's the price of statefulness.
- **Rotation must tolerate races**: the grace window exists specifically because multiple tabs share
  one refresh cookie. Removing it would log out a user's second tab on every rotation.
- **Reuse detection is a tripwire**: a refresh replay after the grace window revokes the whole
  session — defensive against stolen refresh tokens, at the cost of a hard logout if the tripwire
  fires spuriously.
