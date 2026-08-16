# FDR-004: Sharing & Access

**Status:** Active
**Last reviewed:** 2026-08-16

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
- **Leaving.** A member can shed their own access at any time — viewer or editor alike, since leaving
  is not an edit. The owner cannot leave; their exit is deleting the dashboard. Leaving is not a ban:
  a fresh invite re-admits, and only an invite can — every grant is a redeemed code. The feed records
  "you left" rather than "access removed", and nobody is notified.
- **Trashing affects visibility.** Trashed dashboards are filtered out when resolving child-resource
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
**Tradeoff:** None outstanding — the `membership.*` event types this once listed as a leftover have
since been removed.

### 2. Owner is the absence of a share row, resolved as a named role

**Decision:** No share row is ever written for the creator, but `effective_role` reports them as
`EffectiveRole.owner` — not as an absent value. It returns the strongest matching role for a shared
user and raises 404 for no access.
**Why:** The owner isn't a grant — they're the resource's creator; modelling that as "no row" keeps
the grant table strictly about *delegated* access. What the *caller* holds is a different question
from what the table stores, so it gets its own vocabulary rather than borrowing `None`.
**Tradeoff:** Two types over one vocabulary — `ShareRole`, the storable/requestable subset, is
derived from `EffectiveRole` as a `Literal`, so they cannot drift; `test_permissions.py` proves a
client requesting `owner` is rejected at the input boundary.

### 3. Children inherit; their `/shares` endpoints are 409 stubs

**Decision:** Lists and calendar events resolve access through the binding dashboard
(`load_dashboard_access` / `list_accessible_dashboard_ids`); their own `/shares` endpoints
deliberately return 409.
**Why:** Sharing at the dashboard level keeps a bound resource exactly as shared as its dashboard —
no confusing "list shared more widely than the board it's on." See ADR-001.
**Tradeoff:** You can't share a single list independently of its dashboard. The access helpers also
own the trashed-dashboard filter, so child tables must never be queried directly for access.

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

### 6. Direct grant removed — every grant is a redeemed invite (decided 2026-08-16, supersedes 2026-07-26)

**Decision:** `POST /dashboards/{id}/shares` and `DashboardCreate.shares` are gone. The only way a
share comes into being is `accept_invite`, which calls the `create_share` service after the member
redeems a code. `GET`/`PATCH`/`DELETE` on shares remain — the share panel lists, re-roles and
revokes access that redemption created.
**Why:** The 2026-07-26 record kept the direct grant for test convenience, judging it low-risk
because user ids are not discoverable. But ids leak to past co-members permanently, and the grant
attached without the recipient's consent — the one nonconsensual edge in the model, and the only
door a decline list would ever have been needed for. Tests now grant through a mint-and-redeem
helper, which exercises the product path instead of one no user can take.
**Tradeoff:** Programmatic setup (tests, a future admin tool) must mint and redeem an invite —
two calls where one sufficed. An owner re-adding a departed member sends a link rather than
re-attaching them silently; that consent step is the point.

### 7. A member can always leave (decided 2026-08-16)

**Decision:** `DELETE /dashboards/{id}/membership` removes the caller's own share. The server finds
the share itself; share ids stay an owner-only detail. Owner gets a 409.
**Why:** Joining is a consent act (decision 6), and consent must stay withdrawable — without a
leave, an accepted invite becomes a permanent claim on the member's account view, shed only by
asking the owner. Every fan-in surface is bounded by consent only while consent can be revoked from
both sides.
**Tradeoff:** Leaving is not undoable from the leaver's side — the way back is a fresh invite, and
nothing remembers the departure. No block list is needed: with direct grants gone (decision 6),
re-attachment always requires the leaver to redeem a new code. The owner is not notified of a
leave; the departure is visible only in the leaver's own feed.

## Access

This *is* the access model:

- **Owner** (`EffectiveRole.owner`) — creator; full control including delete and share.
- **Editor** — edit the resource and its children.
- **Viewer** — read-only.

Any member may list the dashboard's members (`GET /members` — owner first, with display names):
member names are already mutually visible in the activity feed, and the surfaces that attach
people to things are editor surfaces, not owner ones. Managing shares stays owner-only.

## Related

- **ADRs:** ADR-001 (per-resource sharing), ADR-007 (soft/hard delete boundary), ADR-015 (SSE
  broadcast audience = owner ∪ share principals)
- **FDRs:** FDR-002 (Dashboards & Layout), FDR-005 (Lists), FDR-006 (Calendar & Events)
