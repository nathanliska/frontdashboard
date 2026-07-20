# FDR-004: Sharing & Access

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

How resources are shared between household members and how access is resolved. Sharing is
**per-resource and direct**: you share a *dashboard* with a person; the lists and calendar events
bound to that dashboard inherit the same access. This replaced an earlier groups feature.

## Behavior

- **Share a dashboard with a person.** Search a user by name or email and grant them **viewer** or
  **editor**. The creator is the **owner**.
- **Children inherit.** Lists and calendar events are visible to exactly the people who can see the
  dashboard whose widget binds them. They have no independent sharing UI.
- **Unshare and role change.** Access can be revoked or changed; affected users are notified and their
  preferences (e.g. home dashboard) are cleaned up.
- **Archiving affects visibility.** Archived dashboards are filtered out when resolving child-resource
  access.
- **Search is exact/direct.** You find the specific person to share with by name/email, not a
  directory browse.

## Design Decisions

### 1. Per-resource `ResourceShare` rows, no groups

**Decision:** Sharing is a `ResourceShare` row (`resource_type`, `resource_id`, `principal_type`,
`principal_id`, `role`, `granted_by`). The groups feature was removed.
**Why:** Direct per-resource sharing matches how a household actually shares ("share this list with my
partner") without the indirection of group membership. See ADR-001.
**Tradeoff:** Vestigial `membership.*` event types remain from the removed groups feature.

### 2. Owner is the absence of a share row, not a role value

**Decision:** `effective_role` returns `None` for the creator (owner), a `ShareRole` for a shared
user, and raises 404 for no access.
**Why:** The owner isn't a grant — they're the resource's creator; modelling that as "no row" keeps
the grant table strictly about *delegated* access.
**Tradeoff:** Guards must never write `if role:` — that misreads the owner (`None`) as no access. It's
a documented backend footgun.

### 3. Children inherit; their `/shares` endpoints are 409 stubs

**Decision:** Lists and calendar events resolve access through the binding dashboard
(`load_dashboard_access` / `list_accessible_dashboard_ids`); their own `/shares` endpoints
deliberately return 409.
**Why:** Sharing at the dashboard level keeps a bound resource exactly as shared as its dashboard —
no confusing "list shared more widely than the board it's on." See ADR-001.
**Tradeoff:** You can't share a single list independently of its dashboard. The access helpers also
own the archived-dashboard filter, so child tables must never be queried directly for access.

### 4. Only `user` principals, only viewer/editor roles

**Decision:** `PrincipalType` is `user`; `ShareRole` is `viewer` or `editor`. Both are open StrEnums
but broader principals and richer roles are not built.
**Why:** Household scale doesn't need group/role richness yet; keeping the surface small avoids
speculative complexity. See CONTEXT.md "Deliberately deferred".
**Tradeoff:** No org/group principals and no finer-grained roles until a real need appears.

## Access

This *is* the access model:

- **Owner** (`role is None`) — creator; full control including delete and share.
- **Editor** — edit the resource and its children.
- **Viewer** — read-only.

## Related

- **ADRs:** ADR-001 (per-resource sharing), ADR-007 (soft/hard delete boundary), ADR-015 (SSE
  broadcast audience = owner ∪ share principals)
- **FDRs:** FDR-002 (Dashboards & Layout), FDR-005 (Lists), FDR-006 (Calendar & Events)
