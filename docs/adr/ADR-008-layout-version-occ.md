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
- A 409 never throws. The client resolves the first one itself — re-read the dashboard, overlay this
  drag onto the server's layout by widget id, retry once — and sets `conflict: true` (a banner) only
  if the retry is beaten too, or if the re-read fails.

## Consequences

- **Concurrent editors don't lose work silently**: the check still catches every stale write. What
  changed is who resolves it — the client replays its drag onto the winner's layout and retries, so
  the banner is reserved for someone genuinely being outpaced twice. It fired far more widely
  before, because widget add and delete bump the version too: another user adding a widget anywhere
  made your next drag conflict.
- **Self-conflicts are engineered out client-side**: serialize-plus-coalesce guarantees rapid
  drag/resize can't 409 against itself or install a stale layout — so every 409 is meaningful.
- **The version is load-bearing, not decorative**: any layout/widget write must bump it under the row
  lock, or the OCC check goes blind.
- **The retry merges; the banner still doesn't**: the rebase overlays this client's items onto the
  server's layout by widget id, which it must — `PUT /layout` replaces the array wholesale and never
  checks it against the widget set, so posting a stale array would strip a widget the other editor
  just added. Two clients moving the *same* widget still resolve last-write-wins, and the twice-beaten
  case still resolves by reload. No three-way merge of grid geometry.
