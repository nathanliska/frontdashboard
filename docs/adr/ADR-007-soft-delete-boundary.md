# ADR-007: Soft Delete for Lists/Items/Events; Dashboards Trash Then Purge

**Date:** 2026-07-20 (amended 2026-07-26 — dashboards moved from hard delete to the trash lifecycle, #40)

## Context

Deleting user content is destructive, and a household app benefits from a recovery path for the
content people actually accumulate — lists, list items, calendar events. But not every entity earns
the complexity of soft delete: containers whose loss is cheap to recreate, and whose lingering rows
would complicate access resolution, are better removed outright.

Soft delete also has real costs: every query must filter the tombstone, and forgetting the filter
silently leaks deleted rows.

## Decision

Split the boundary by entity:

- **Soft delete** (`deleted_at` column, filtered in every query) for `User`, `List`, `ListItem`,
  `CalendarEvent` — the durable, user-authored content.
- **Trash, then purge** (amended, #40) for `Dashboard`: DELETE stamps `deleted_at`, the dashboard
  disappears from every listing and access path (children included — they resolve access through
  it), stays restorable from the owner's trash for `trash_retention_days` (30), and the retention
  reaper then runs the real cascade (widgets, lists/items, events, shares). The original rationale
  — "containers are disposable" — did not survive contact with sharing: a dashboard is the access
  root for everything on it, so one misclick permanently destroyed content several people used.
- **Hard delete** remains for `DashboardWidget` alone — genuinely disposable scaffolding.

Lists must be **archived before delete** (409 otherwise); delete then cleans up bound widgets and
shares. Individually soft-deleted lists/items/events are also purged by the reaper past the same
horizon (before #40 they lingered forever). Soft delete is manual and per-table — there is no
global scope filter.

## Consequences

- **Recoverable content, disposable containers**: the data users would mourn is tombstoned; the
  layout scaffolding around it is cheap to rebuild and is removed cleanly.
- **Every content query must filter `deleted_at`**: this is a standing footgun — an unfiltered query
  resurrects deleted rows. It's a documented backend convention, not an ORM-enforced default.
- **Cascade cleanup is explicit and lives in the reaper** (`reap_expired_trash`): dashboards own
  child resources without ON DELETE cascades, so the purge fans out to widgets, shares, and bound
  resources by hand — now on the retention schedule instead of the request path.
- **Restore is owner-only and total**: shares and children come back exactly as they were;
  favorites do not (dropped at trash time, mirroring archive).
- **Archive-before-delete is a guard rail**: the 409 forces an intentional two-step for lists,
  reducing accidental loss and giving share/widget cleanup a defined trigger point.
