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
2. **`manager.broadcast(...)` *after* commit**, so subscribers only ever see committed state.
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
- **This ordering is a hard convention, not a helper**: it lives in each route, so it's documented in
  [AGENTS.md](../../AGENTS.md) as "SSE ordering is load-bearing."
