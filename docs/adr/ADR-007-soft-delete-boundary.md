# ADR-007: Soft Delete for Lists/Items/Events, Hard Delete for Dashboards

**Date:** 2026-07-20

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
- **Hard delete** for `Dashboard` and `DashboardWidget` — the containers. Hard-deleting a dashboard
  also removes its owned lists/items/events/widgets/shares.

Lists must be **archived before delete** (409 otherwise); delete then cleans up bound widgets and
shares. Soft delete is manual and per-table — there is no global scope filter.

## Consequences

- **Recoverable content, disposable containers**: the data users would mourn is tombstoned; the
  layout scaffolding around it is cheap to rebuild and is removed cleanly.
- **Every content query must filter `deleted_at`**: this is a standing footgun — an unfiltered query
  resurrects deleted rows. It's a documented backend convention, not an ORM-enforced default.
- **Cascade cleanup on dashboard delete is explicit**: because dashboards are hard-deleted and own
  child resources, the delete path must fan out to widgets, shares, and bound resources by hand.
- **Archive-before-delete is a guard rail**: the 409 forces an intentional two-step for lists,
  reducing accidental loss and giving share/widget cleanup a defined trigger point.
