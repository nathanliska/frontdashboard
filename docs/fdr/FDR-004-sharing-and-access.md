# FDR-004: Sharing & Access

**Status:** Active
**Last reviewed:** 2026-07-26

## Overview

How resources are shared between household members and how access is resolved. Sharing is
**per-resource and direct**: you share a *dashboard* with a person; the lists and calendar events
bound to that dashboard inherit the same access. This replaced an earlier groups feature.

## Behavior

- **Share a dashboard by invite link.** The owner mints a single-use link carrying a role — **viewer**
  or **editor** — and sends it to the person themselves. The creator is the **owner**. There is no way
  to look up a user, so nobody can be added without being handed a link.
- **Redeeming.** Opening the link shows the dashboard name, who invited you, and the role, signed in
  or not; accepting is a separate POST that consumes the code and grants the share. Codes expire, can
  be revoked while unused, and are shown to the minter exactly once.
- **Children inherit.** Lists and calendar events are visible to exactly the people who can see the
  dashboard whose widget binds them. They have no independent sharing UI.
- **Unshare and role change.** Access can be revoked or changed; affected users are notified and their
  preferences (e.g. home dashboard) are cleaned up.
- **Archiving affects visibility.** Archived dashboards are filtered out when resolving child-resource
  access.
- **Only the invite carries identity outward.** The preview names the inviter and the dashboard,
  because the recipient has to know what they are joining. Nothing else in the product will tell one
  user that another exists.

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

### 5. Access is granted by handing out a link, not by looking someone up

**Decision:** Shares are created by minting a single-use `DashboardInvite` and sending the link to the
recipient out of band. The user-search endpoint was deleted rather than hardened; the code is stored
only as a SHA-256 hash, alongside `expires_at`/`used_at`, and is swept by the same retention reaper as
the other token tables.
**Why:** Registration is open to the internet, so any lookup that answers "does this person exist"
answers it for strangers too. An exact-email invite still confirms an address on a hit; a link
confirms nothing, because possession of the code *is* the authorization. Redeeming is a POST so that
link scanners and message previews can't burn an invite by fetching it.
**Tradeoff:** Anyone who obtains the link can redeem it — mitigated by single use, expiry, and
revocation, not by identity. Minting is restricted to share managers so an editor can't widen who sees
a dashboard.

### 6. Direct grant stays as an API capability, with no UI (decided 2026-07-26)

**Decision:** `POST /dashboards/{id}/shares` and `DashboardCreate.shares` grant access by user id and
remain, even though no client calls them. The product's only path to access is an invite link.
**Why:** This is the direct per-resource grant [ADR-001](../adr/ADR-001-per-resource-sharing.md)
preserves, and it is what the test suite uses to construct every shared-dashboard scenario — the
alternative was rewriting that setup across five test modules to mint and redeem invites, which buys
no coverage. Keeping it is also low-risk: calling it already requires managing shares on the target
dashboard, and user ids are no longer discoverable, so it grants nothing an invite link wouldn't.
**Tradeoff:** A live endpoint the UI can't reach, which will read as dead surface to anyone auditing
the API — hence this entry. `GET`/`PATCH`/`DELETE` on shares *are* client-reachable: they are how the
share panel lists, re-roles and revokes access after an invite is redeemed.

## Access

This *is* the access model:

- **Owner** (`role is None`) — creator; full control including delete and share.
- **Editor** — edit the resource and its children.
- **Viewer** — read-only.

## Related

- **ADRs:** ADR-001 (per-resource sharing), ADR-007 (soft/hard delete boundary), ADR-015 (SSE
  broadcast audience = owner ∪ share principals)
- **FDRs:** FDR-002 (Dashboards & Layout), FDR-005 (Lists), FDR-006 (Calendar & Events)
