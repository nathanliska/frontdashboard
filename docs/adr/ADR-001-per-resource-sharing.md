# ADR-001: Per-Resource `ResourceShare` Sharing (Groups Removed)

**Date:** 2026-07-20 (amended 2026-08-08)

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
(`load_dashboard_access` / `list_accessible_dashboard_ids`), which also filters trashed dashboards.

`PrincipalType` currently has only `user`; `ShareRole` only `viewer`/`editor`. Both are modelled as
open StrEnums so more principal types or roles *could* be added, but broader principals and richer
roles are intentionally not built (see CONTEXT.md "Deliberately deferred").

### The polymorphism is pinned, not preserved (amended 2026-07-27)

`resource_shares.resource_id` was designed to name a list, a calendar event *or* a dashboard, which
is why it spent its whole life without a foreign key: no single FK can express "points at one of
three tables". Inheritance made that generality unreachable — migration `q6s8u0w2y4a6` deleted the
last list and event share rows, the child `/shares` endpoints are 409 stubs, and both write paths
pass `ResourceType.dashboard` literally.

**Decision: pin the discriminators and take the foreign keys** (finding #19). `resource_type` is
constrained to `'dashboard'` and `principal_type` to `'user'` by CHECK constraints, which makes
`resource_id → dashboards.id` (ON DELETE CASCADE) and `principal_id → users.id` expressible. The
alternatives — per-type share tables, or a set of typed nullable columns with an exactly-one-set
check — both buy a generality this app decided against; with one live type they are the same schema
with more moving parts.

The columns keep their names and the enum keeps its members (`DashboardWidget.resource_type` is
still genuinely polymorphic over lists and events). Re-opening sharing to another resource type is
therefore a migration that drops one CHECK and one FK, not a redesign.

## Consequences

- **Simple mental model**: "I shared this dashboard with Alice as editor." No group indirection.
- **Inheritance keeps child sharing coherent**: a list is visible to exactly the people who can see
  the dashboard binding it — you can't create a list more or less shared than its dashboard. The
  cost is that you can't share a single list independently of its dashboard.
- **Owner is stored as no row, resolved as a role**: the grant table holds nothing for the creator,
  but `permissions.effective_role` returns `EffectiveRole.owner` rather than `None`. The storable
  subset `ShareRole` is derived from that enum as a `Literal`, keeping `owner` unrequestable while
  killing the `if role:` guard that read the owner as "no access" ([AGENTS.md](../../AGENTS.md)).
- **Trashed-visibility invariant lives in the access helpers**: querying a child table directly
  bypasses the trashed-dashboard filter, so all child access must route through the shares service.
- **A share row cannot outlive what it names**: the FKs mean a purged dashboard takes its grants
  with it in the same statement, and a share can never be written against a dashboard or user that
  does not exist. The trash reaper's hand-ordered share deletes were removed with the constraint,
  as was the inheritance-discovery half of `services/shares.py` — a widget-join that looked for
  *every* dashboard binding a resource, which stopped having a second row to find once lists and
  events became dashboard-owned.
- **No vestiges left**: the `EventType.membership_*` members this ADR once recorded as cleanup debt
  are gone — every one of the 20 remaining members is emitted by live code (verified 2026-07-27).
