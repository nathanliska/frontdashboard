# ADR-006: REST for Initial Fetch, SSE for Incremental Patch

**Date:** 2026-07-20

## Context

Given SSE as the real-time transport (ADR-004), we need a rule for how a resource's data gets into
the client and stays fresh. Two anti-patterns to avoid: (a) refetching everything on every event
(chatty, defeats the point of real-time), and (b) trying to bootstrap initial state over the event
stream (SSE is a tail of changes, not a snapshot API).

We also have a self-echo problem: a client that just mutated a resource will receive its own change
back over SSE and must not double-apply it.

## Decision

Every resource does an **initial REST fetch**; **SSE events then patch caches in place**.

- **Hot events carry the new state.** List reorder and item check/update payloads carry the changed
  fields (or the id order), so other clients patch in place with no follow-up GET. A refetch happens
  only if the payload is absent (older events) or the patched result diverges from cache.
- **Cold events invalidate-and-refetch.** Rarer events (create/delete/archive) deliberately keep the
  self-healing invalidate-and-refetch path — correctness is worth more than bytes on cold paths.
- **Echo suppression.** Mutations send a `clientMutationId`; the matching SSE echo is skipped via
  `consumePending…MutationEcho`. On mutation *error* the client must `forgetPending…Mutation(id)` or
  the bookkeeping leaks.
- **Wiring is two-sided.** A new entity type needs both its event names in `hooks/useSSE.ts` and a
  `handleXResourceEvent` router in `resources/*` — miss either and the UI silently goes stale
  ([frontend/CLAUDE.md](../../frontend/CLAUDE.md)).

## Consequences

- **Minimal network on hot paths**: the common mutations (check an item, reorder) propagate as a
  single in-place patch, no round-trip.
- **Self-healing on cold paths**: create/delete/archive re-fetch, so a missed or malformed event
  can't leave the UI permanently wrong for those operations.
- **Echo bookkeeping is a leak risk**: the `clientMutationId` map must be cleaned on both success and
  error; the error-path `forgetPending…` is easy to forget and has no visible symptom until it
  accumulates.
- **Payload shape is part of the contract**: hot events must carry enough to patch; changing a
  payload to omit a field silently forces the divergence-refetch fallback.
