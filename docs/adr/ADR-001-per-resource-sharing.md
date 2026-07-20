# ADR-001: Per-Resource `ResourceShare` Sharing (Groups Removed)

**Date:** 2026-07-20

## Context

The original design had a "groups" feature: users joined groups, and resources were shared with a
group. This coupled two concerns — *who is in a household unit* and *who can see this dashboard* —
and made the mental model heavy for a small, self-hosted household app where sharing is usually
one-off ("share the chores list with my partner"). Groups also left vestigial `membership.*` event
types and role machinery behind.

We need a sharing model that is direct, per-resource, and simple enough to reason about for a
handful of users, while still distinguishing read-only from collaborative access.

## Decision

Remove groups. Share each resource directly with a user via a `ResourceShare` row
(`resource_type`, `resource_id`, `principal_type`, `principal_id`, `role`, `granted_by`). The
creator is the **owner** (represented by the *absence* of a share row, not a role value); other
users hold a `viewer` or `editor` role.

Only **dashboards** are shared directly. Lists and calendar events **inherit** access from the
dashboard whose widget binds them — their own `/shares` endpoints are deliberate 409 stubs. Access
for a child resource is resolved through the binding dashboard
(`load_dashboard_access` / `list_accessible_dashboard_ids`), which also filters archived dashboards.

`PrincipalType` currently has only `user`; `ShareRole` only `viewer`/`editor`. Both are modelled as
open StrEnums so more principal types or roles *could* be added, but broader principals and richer
roles are intentionally not built (see CONTEXT.md "Deliberately deferred").

## Consequences

- **Simple mental model**: "I shared this dashboard with Alice as editor." No group indirection.
- **Inheritance keeps child sharing coherent**: a list is visible to exactly the people who can see
  the dashboard binding it — you can't create a list more or less shared than its dashboard. The
  cost is that you can't share a single list independently of its dashboard.
- **Owner is `role is None`, not a role value**: `permissions.effective_role` returns `None` for the
  creator and raises 404 for no access. Guards must never write `if role:` — that misreads the owner
  as "no access" ([backend/CLAUDE.md](../../backend/CLAUDE.md)).
- **Archived-visibility invariant lives in the access helpers**: querying a child table directly
  bypasses the archived-dashboard filter, so all child access must route through the shares service.
- **Vestiges remain**: `EventType.membership_*` values persist as dead enum members from the removed
  groups feature (CONTEXT.md), a small cleanup debt.
