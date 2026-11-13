# ADR-006: REST for Initial Fetch, SSE for Incremental Patch

**Date:** 2026-07-20 (amended 2026-08-09, 2026-11-12, 2026-11-13)

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
  fields (or the id order), an item create carries the whole new row and an item delete names its
  item, so other clients patch in place with no follow-up GET. A refetch happens only if the
  payload is absent (older events), the client does not hold the list or holds it stale, or the
  patched result diverges from cache.
- **Cold events invalidate-and-refetch.** Rarer events, such as a list being created,
  deliberately keep the self-healing invalidate-and-refetch path: correctness is worth more than
  bytes on cold paths.
- **Echo suppression.** Every mutation carries the tab's per-load id (`X-Client-Id`, stamped
  centrally in `apiFetch`); the SSE payload echoes it back as `origin_client_id` and a frame
  stamped with this tab's id is skipped. A pure comparison — no per-mutation bookkeeping.
  (Amended 2026-08-09: a per-mutation id registry preceded this; FDR-008 records the trade.)
- **Wiring is two-sided.** A new entity type needs both its event names in `hooks/useSSE.ts` and a
  `handleXResourceEvent` router in `resources/*` — miss either and the UI silently goes stale
  ([AGENTS.md](../../AGENTS.md)).

## Consequences

- **Minimal network on hot paths**: the common mutations (check an item, reorder) propagate as a
  single in-place patch, no round-trip.
- **Self-healing on cold paths**: the events that still re-fetch cannot leave the UI permanently
  wrong after a missed or malformed frame.
- **A lost mutation response leaves the issuing tab stale**: its echo is suppressed regardless,
  so recovery waits for the retried action, the next foreign event, or a resync. Accepted — a
  per-mutation registry could not close the window either, and cost bookkeeping at every call site.
- **A read never overwrites a change that overtook it.** Each cache entry counts its writes, and
  a fetch applies its answer only if the count has not moved since it started. Overtaken by a
  patch, which is partial, the read is issued again at once and the patched state stays on screen
  meanwhile. Overtaken by a seed, which is authoritative, the answer is dropped and nothing more
  is read. Invalidated mid-flight, the answer is applied and a mounted scope reads again, while
  an unmounted one waits for its next mount. A caller that joins a read already out, after an
  invalidate, is owed one newer than it. A failed read is never retried on its own. This is
  the cache layer's job, not each event handler's.
- **Payload shape is part of the contract**: hot events must carry enough to patch; changing a
  payload to omit a field silently forces the divergence-refetch fallback.
