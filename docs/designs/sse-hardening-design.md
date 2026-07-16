# Design — SSE hardening: reliable delivery, then payload-carrying events

**Date:** 2026-07-16
**Status:** 🚧 Design — not started
**Findings:** #8 (bound SSE authorization / close evicted streams), #21 (durable, multi-process
delivery), #24 (lifecycle-aware query layer). Builds on the reorder work
(`docs/shipped/list-reordering-design.md`), which introduced the payload-carrying pattern.

## Theme

Today every list mutation except reorder makes each observing client **refetch the whole
resource** to learn what changed. Reorder proved the alternative: an event that carries the new
state, applied in place, with no GET. This doc generalises that — but **reliability first**,
because patching trades away refetch's self-healing property and is only safe once a client can
tell it missed something.

Two phases, in order. Phase 1 is a prerequisite for Phase 2, not a nice-to-have.

---

## Why reorder is GET-free and the rest is not (verified)

Two halves, both required:

1. **The event is self-sufficient.** `list.item.checked` carries
   `{"fields": ["checked"], "list_id", "dashboard_id"}` — *which* field changed, never the new
   value. The client cannot apply it; it must ask the server. `list.item.reordered` carries
   `{"item_ids": [...]}` — the complete new order, so nothing needs asking.
2. **The handler patches instead of invalidating.** Existing events call
   `listDetailQuery.invalidateWhere(...)` (mark stale → refetch if listeners exist). The reorder
   branches call `updateWhere(...)`, applying the payload directly.

Neither half works alone: a self-sufficient payload still refetches if the handler invalidates,
and `updateWhere` cannot help if the payload does not say what changed.

### Cost, measured against the current code

`fetchIfStale` no-ops when an entry is fresh and `fetch` dedupes via `inFlight`, so a
`list.item.checked` with an agenda mounted costs **~1 GET**, not the N+1 an earlier note claimed.
That one GET returns the **entire list detail** to convey one boolean.

| Scenario | Refetch (today) | Payload-carrying | Ratio |
| --- | --- | --- | --- |
| Check 1 item, 50-item list | ~10 KB | ~0.4 KB | ~25× |
| Check 1 item, 500-item list | ~100 KB | ~0.4 KB | ~250× |
| Reorder 50 lists | ~10 KB | ~1.9 KB | ~5× |
| Reorder 500 items | ~100 KB | ~18.5 KB | ~5× |

The asymmetry drives the whole design: **a small delta on a large collection** is where
payload-carrying wins, and the gap **grows with collection size** (refetch scales with the
collection; the delta does not). Reorder itself only wins ~5×, because its payload also scales
with N — the technique's real value is on the events reorder did *not* touch.

### What we give up

Refetch is dumb but **self-healing**: any event, even a malformed one, converges the client on
server truth. Patching is precise but assumes nothing was missed — a dropped event means silent,
permanent divergence. That is acceptable only with a reliable way to detect loss, which is why
Phase 1 comes first.

---

## Phase 1 — make delivery loss detectable (finding #8)

### Current behavior (verified in code)

`backend/app/sse/manager.py:60-65` — when a client's queue is full, `broadcast` calls
`self.disconnect(client)`, removing it from `_clients`. Nothing is sent to that client and its
HTTP response stays open. The generator (`backend/app/routers/sse.py:38-45`) loops on
`asyncio.wait_for(client.queue.get(), timeout=5.0)` and simply `continue`s on timeout — it never
checks whether it is still registered.

**Consequence:** an evicted client remains connected, receives **nothing, forever**, and never
reconnects — so `EventSource`'s auto-reconnect and the `Last-Event-ID` → `resync` path never
fire. The comment at `manager.py:63-64` claiming the generator "detects closure" is false.

This is the failure mode that matches a real reported symptom: two tabs, one silently stops
receiving while its own mutations still reach the other. It is a hazard under refetch and fatal
under patching.

### Target behavior

- `_Client` gains a `closed: asyncio.Event` (or a sentinel pushed onto the queue).
- Eviction **signals** the client instead of silently dropping it: set `closed` / enqueue a
  sentinel, then remove from `_clients`.
- The generator selects on both the queue and `closed`. On close it yields a **`resync`** frame
  and returns, ending the response. The browser's `EventSource` reconnects, sends
  `Last-Event-ID`, and `_should_resync_on_connect` triggers a full resync — the existing,
  already-working recovery path.
- `disconnect()` stays idempotent (double-close guard).

### Why this is the prerequisite

It converts "silently deaf forever" into "reconnect and resync." Every later patch-based event
depends on that guarantee.

### Tests

- Evicting a client (fill its queue past `_QUEUE_MAX`) causes its generator to terminate rather
  than hang.
- An evicted-then-reconnected client receives `resync`.
- `disconnect()` remains idempotent; a normal disconnect still cleans up `_clients`.
- Existing SSE tests keep passing.

> **Test-harness note:** `backend/tests/test_sse.py:149-154` states the full streaming pipeline is
> not covered, because httpx's ASGI transport cannot cleanly close infinite SSE generators. That
> gap is why this class of bug survived. Phase 1 should test the **generator function directly**
> (drive `_generate()` and assert termination) rather than through the ASGI client — no new
> transport needed.

### Out of scope

Finding #21's durable/multi-process delivery (Redis pub/sub, replay-from-`event_id`). The app runs
a single uvicorn worker today, so the module-level manager is sufficient; #21 becomes real when a
second worker does. Phase 1 does not block it.

---

## Phase 2 — payload-carrying events for the hot paths

Only after Phase 1.

### Convert (high frequency, small delta, server can state the new value)

| Event | Payload gains | Client action |
| --- | --- | --- |
| `list.item.checked` | `checked: bool` | patch that item in `detail.items` |
| `list.item.updated` | the new values of changed `fields` (e.g. `text`, `due_date`, `priority`, `category`, `assigned_to`) | patch those fields on that item |

The payload already carries `fields`; this adds the corresponding values. `entity_id` identifies
the item, so no lookup is needed.

### Do NOT convert (keep invalidate-and-refetch)

- `list.item.created` — the server computes `sort_order`, timestamps, ids. Sending a whole item
  duplicates the response DTO and invites drift; creates are comparatively rare.
- `list.created` / `list.deleted` / `list.archived` — rare; deletes and archives change
  membership and `item_count`.
- Share/permission changes — rare, security-relevant, and self-healing is worth more than bytes.
- Dashboard layout — different machinery (Zustand store, debounce/serial coalescing, version
  conflict protocol). Same principle, separate work.

### Divergence guard (per event)

Mirror the reorder pattern: if the target of a patch is not in cache (e.g. an item the client has
never seen), fall back to **one** refetch of that scope. Rare path, not the common one.

### `updateWhere` and `stale` (finding #24 adjacency)

`scopedQuery.updateWhere` clears `entry.stale` (`frontend/src/resources/scopedQuery.ts`). That is
correct — a patch writes authoritative data — and the reorder path depends on it (the agenda's
`fetchIfStale` then resolves from cache rather than re-GETting a scope we just patched).

The cost: clearing `stale` also **discards the record of an earlier missed event**. An entry
marked stale by an `invalidateWhere` that skipped its fetch (no live listeners) is silently marked
fresh again by the next patch, and that missed update is lost until a resync. Phase 2 multiplies
the number of patching events, so it must address this rather than inherit it:

- **Option A (preferred):** track `staleReason`; a patch clears freshness doubt only for what it
  actually wrote, so a prior missed invalidate survives.
- **Option B:** leave `stale` set on event-driven patches. Costs one redundant GET per patched
  scope (not an N+1 — an earlier comment overstated this), which partly defeats the point.

Option A, decided with #24 in view. **Audit every `updateWhere` caller before changing the
semantics** — the mutation paths rely on current behavior too.

### Ordering coupling

`useSSE.onListEvent` fans each event to the list handler, then agenda, then dashboard. The list
handler must run first — it clears `stale`, so the agenda's `fetchIfStale` resolves from cache.
Documented in code; keep it true, and prefer removing the coupling (via Option A) over relying on
it.

### Contract risk (finding #23)

Each payload becomes a wire contract consumed by hand-written TypeScript. Backend/frontend drift
would silently mis-patch caches. Prefer landing this **after**, or alongside, generated types.
Until then, every converted event needs a backend test asserting its exact payload shape and a
frontend test asserting the patch.

---

## Testing

- **Backend:** each converted event emits its new value(s); payload shape asserted per event type.
- **Frontend:** each converted event patches the cache and issues **no GET** (assert the fetcher
  was never called — with a live listener mounted, or the assertion is vacuous, as the reorder
  tests found); divergence triggers exactly one refetch; self-echo suppression still holds.
- **Phase 1:** as above, driving `_generate()` directly.

## Sequencing

1. Phase 1 (#8) — small, independently valuable, unblocks everything.
2. `updateWhere` / `stale` semantics (Option A).
3. Convert `list.item.checked`, then `list.item.updated`.
4. Re-evaluate. #21 only when a second worker is real.

## Deliberately not doing

- Converting every event "for consistency" — self-healing is worth more than bytes on rare paths.
- Redis / multi-process delivery while a single worker is deployed (#21).
- Dashboard layout events.
