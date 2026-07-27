# ADR-007: Soft Delete for Lists/Items/Events; Dashboards Trash Then Purge

**Date:** 2026-07-20 (amended 2026-07-26 — dashboards moved from hard delete to the trash lifecycle, #40; amended 2026-07-27 — archive removed, trash is the only put-away state)

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

Lists follow the same trash contract as dashboards (amended 2026-07-27): DELETE stamps `deleted_at`,
unbinds the widgets that showed the list, and the list is restorable from the trash until the reaper
purges it past the same horizon. The old **archive-before-delete** 409 gate is gone, and with it the
`archived` flag on both dashboards and lists — see "Archive removed" below. Soft delete is manual and
per-table; there is no global scope filter.

### Archive removed (amended 2026-07-27)

`archived` and the trash were two overlapping "put away" concepts with incompatible promises: archive
was permanent but had no restore vocabulary, trash is recoverable but expires. Carrying both meant
every access query filtered two flags, every UI had two hide-this actions, and the user had to know
which one was reversible. Trash won because it can do archive's job safely; archive could never do
trash's. **Existing archived rows were un-archived, not trashed** — stamping `deleted_at` would have
started a purge clock on data whose owner explicitly chose to keep it.

## Consequences

- **Recoverable content, disposable containers**: the data users would mourn is tombstoned; the
  layout scaffolding around it is cheap to rebuild and is removed cleanly.
- **Every content query must filter `deleted_at`**: this is a standing footgun — an unfiltered query
  resurrects deleted rows. It's a documented backend convention, not an ORM-enforced default.
- **Cascade cleanup is explicit and lives in the reaper** (`reap_expired_trash`): dashboards own
  child resources without ON DELETE cascades, so the purge fans out to widgets, shares, and bound
  resources by hand — now on the retention schedule instead of the request path.
- **Restore is total**: shares and children come back exactly as they were; favorites and home do
  not (dropped at trash time). Dashboard restore is owner-only (the trash is the owner's space);
  list restore runs through dashboard edit access, so a list whose dashboard is itself trashed
  cannot be restored on its own — restoring the dashboard brings it back.
- **One put-away state to filter and explain**: every access/listing/inheritance query filters
  `deleted_at` alone, and the UI has exactly one "hide this" action, which is reversible. The cost
  is that there is no longer a way to keep something indefinitely out of the way *without* a purge
  deadline — a dashboard you want to keep but not see must simply stay in the list.
- **Recovery is uniform across container types**: dashboards and lists have the same delete verb,
  the same 30-day window, and the same restore action. Items and events stay immediate-delete —
  a trash bin at that granularity is noise, and their recovery story is restoring the container.
