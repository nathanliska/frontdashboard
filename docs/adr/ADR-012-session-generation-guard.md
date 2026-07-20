# ADR-012: Session-Generation Guard for Auth-Boundary State Reset

**Date:** 2026-07-20

## Context

A single browser tab can cross an auth boundary without a full page reload: login, logout, email
verification, or an unauthenticated startup. When it does, the previous account's client state must
not survive into the next. Two failure modes:

1. **Stale caches** — the previous user's dashboards/lists/notifications remain in memory.
2. **In-flight responses** — a request fired *before* the boundary resolves *after* it and writes the
   old account's data into the new account's state (a "late write").

Clearing caches on the boundary handles (1) but not (2): a response already in flight will still land.

## Decision

Reset all client state at every auth boundary, and guard every async write with a shared
**session-generation counter**:

- On login/logout/verify/unauthenticated-startup, clear notifications, resource caches, and the
  dashboard store (fields, in-flight machinery, pending mutations).
- A shared **session-generation counter** guards every async write in the **dashboard, auth, and
  notifications** stores: each async action **captures the generation at entry** and **drops its
  post-await write if the generation changed** (a boundary crossed).
- Logout tears down the session view and SSE stream **before** its network round-trip.

## Consequences

- **No cross-account leakage in a shared tab**: a prior account's in-flight response can't repopulate
  the next account's dashboards, `user`, or notifications.
- **Every async store write must opt in**: the guard only protects stores that capture-and-check the
  generation. A new store holding account-scoped state must adopt the pattern *and* wire a reset, or
  it reintroduces the leak.
- **Reset must reach both state layers**: because state is split (ADR-005), the boundary reset has to
  clear Zustand stores *and* every scoped-query resource cache.
- **Tear-down-before-round-trip on logout**: killing the SSE stream and session view before the
  network call prevents a last event from repopulating state during logout.
