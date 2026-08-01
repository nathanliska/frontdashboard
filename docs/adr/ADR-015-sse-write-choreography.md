# ADR-015: SSE Write Choreography — Build Before Commit, Broadcast After

**Date:** 2026-07-20

## Context

A mutating route does two things that must stay consistent: it commits a database transaction, and it
broadcasts an SSE event describing the change (ADR-004/ADR-006). Getting the order wrong breaks
subscribers:

- **Broadcast before commit** and a subscriber can fetch/patch against data that isn't committed yet
  (or that rolls back), showing a change that never durably happened.
- **Build the event payload after commit** and the ORM objects may be expired/detached (post-commit
  the session expires attributes), so the payload can't be reliably constructed.

There's also an *audience* question: broadcasting to the wrong set of users leaves other people's
open tabs stale.

## Decision

Fix the choreography for every mutating route:

1. **Build the event dict *before* commit** (`app/sse/events.py` — flush/refresh), while the ORM
   objects are live and attributes are populated.
2. **Commit and fan out through `sse/choreography.py`**, which commits and then broadcasts, so
   subscribers only ever see committed state. Routes hand it prepared `Fanout`s and never reach for
   `manager.broadcast` themselves; `test_sse_choreography_coverage.py` fails the build on a router
   that does.
3. **Broadcast to `{dashboard.user_id} ∪ share principal_ids`** (the owner plus everyone the resource
   is shared with) — miss a principal and their open tab silently goes stale.

Supporting rule: `log_event(...)` and `stage_notification(...)` only `db.add`; the **route owns the
single commit**, so activity events and notifications land in the *same* transaction as the mutation.

## Consequences

- **Subscribers never see uncommitted or rolled-back state**: broadcast strictly follows commit.
- **Payloads are always constructable**: building before commit sidesteps post-commit attribute
  expiry.
- **Activity + notification atomicity**: because helpers only `db.add` and the route owns the commit,
  a mutation and its audit/notification records commit or roll back together — no orphaned events.
- **Audience correctness is manual**: the broadcast set must be computed from owner + share
  principals on every route; it's a load-bearing detail with a silent failure mode (stale tabs).
- **The ordering is now structural, not a convention**: it lives in one function rather than at every
  mutating route, and a test rejects any router that bypasses it. Building the payload before the
  commit and choosing the audience remain the route's job, so those two stay conventions — the seam
  narrows what can silently go wrong, it does not eliminate it.
