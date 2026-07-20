# ADR-008: Layout Version Integer for Optimistic Concurrency Control

**Date:** 2026-07-20

## Context

A dashboard's grid layout can be edited from more than one place — two tabs, two household members
with editor access, a phone and a wall display. Two editors saving concurrently could silently
clobber each other's arrangement. We need to detect a genuine conflict without pessimistic locking
of the editing session (which would block the other editor for the whole edit).

There's also a *self*-conflict hazard: rapid drag/resize fires many layout saves in quick
succession, and naive concurrent PUTs could install an *older* layout over a newer one.

## Decision

Give each dashboard a monotonically increasing **`version` integer** and use optimistic concurrency
control:

- `PUT /layout` compares the client's version against the server's; a mismatch returns **409**.
- Layout/widget writes take the dashboard **row lock** (`lock_for_update=True`) *and* bump
  `dashboard.version`.
- On the client, layout saves are **serialized and coalesced**: one PUT in flight plus one
  latest-pending layout, each send re-reading the version the previous save returned. A 409 therefore
  means a *real* other-editor conflict, never self-contention.
- A 409 sets `conflict: true` (a banner), it does **not** throw; resolution reloads the current
  layout.

## Consequences

- **Concurrent editors get a clear conflict signal instead of silent loss**: the last writer doesn't
  win by accident; the loser sees a banner and reloads.
- **Self-conflicts are engineered out client-side**: serialize-plus-coalesce guarantees rapid
  drag/resize can't 409 against itself or install a stale layout — so every 409 is meaningful.
- **The version is load-bearing, not decorative**: any layout/widget write must bump it under the row
  lock, or the OCC check goes blind.
- **Resolution is reload, not merge**: conflicts are resolved by reloading the winner's layout, not
  by three-way merging grids — simpler and adequate for the rare true-conflict case.
