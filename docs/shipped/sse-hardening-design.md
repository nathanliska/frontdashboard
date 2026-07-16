# Design — SSE hardening: reliable delivery, then payload-carrying events

**Date:** 2026-07-16
**Status:** ✅ Shipped 2026-07-16 (`44a9e15`, `8f2028f`, `6fd1f31`). All three phases landed.
#8's authorization half was never in this doc's scope and stays open — see
`docs/references/review-findings.md`. Deviations from this design are recorded at the bottom.
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

### Out of scope for Phase 1

Finding #21's durable/multi-process delivery (Redis pub/sub, replay-from-`event_id`). The app runs
a single uvicorn worker today, so the module-level manager is sufficient; #21 becomes real when a
second worker does. Phase 1 does not block it.

### #8's other half — deliberately deferred, and why

Finding #8 bundles **two unrelated problems**. Phase 1 fixes the eviction one (the prerequisite for
patching). The other — *"Authentication happens only when the stream opens, so a stream can receive
household events beyond the 15-minute JWT lifetime or after account/session revocation"* — is **not**
addressed here. `get_current_user_for_stream` authenticates once at connect; the stream then runs
unbounded with no re-check. **#8 must therefore be marked ◐ Partially done, never ✅.**

Reasons for deferring, not dodging:

- **It belongs with #7.** The rollout table puts #8 in Phase 2 (Auth/session hardening) alongside
  #7, whose own text says "existing access tokens and SSE streams also continue." Both need the same
  session-revocation/expiry mechanism; building it here would duplicate what #7 must build anyway.
- **The exposure is narrower than the finding's wording.** Share removal is already handled — the
  audience is recomputed per broadcast from current shares (`load_dashboard_access` →
  `_dashboard_user_ids`), so revoking a share stops that dashboard's events immediately. The live
  gap is an **expired JWT or revoked session** (logout, password change) still streaming events for
  dashboards the user retains shares on.
- **Closing streams at expiry without a client refresh path would cause an outage, not security.**
  See Phase 3 — that path doesn't exist yet, so it is the honest prerequisite.

---

## Phase 3 — client resilience (prerequisite for bounding stream lifetime)

`frontend/src/hooks/useSSE.ts` has **no `onerror` handler at all**. Consequences:

- `apiFetch`'s single-flight 401 refresh (`api/client.ts:10-23`) does not help: that is `fetch`;
  `EventSource` is a separate browser API and cannot run that flow.
- Per the HTML spec, `EventSource` auto-retries **network** drops (`readyState === CONNECTING`) but
  **fails permanently on an HTTP error status** such as 401 (`readyState === CLOSED`, no retry).
- So today, if the stream is ever rejected on auth, real-time updates die silently for that tab
  until a reload — and any future "close the stream at token expiry" (the #8 authz half) would turn
  that into a guaranteed outage every 15 minutes.

`readyState` is the discriminator the missing status code denies us:

- `CONNECTING` → the browser is already retrying a transient drop. Do nothing.
- `CLOSED` → the server rejected us. Attempt a refresh; on success reconnect; on failure send the
  user to `/login`, exactly as `apiFetch` does.

Reuse `tryRefresh` (export it from `api/client.ts`) so SSE and REST share **one** single-flight
refresh rather than racing two. Guard against a tight reconnect loop (a refresh that succeeds while
the stream still rejects) with a bounded retry/backoff.

This is worth doing now regardless of #8: it is small, it fixes a real silent-failure today, and #7
needs it. It does **not** by itself close #8's authz half — it makes closing it possible without an
outage.

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
the number of patching events, so it must address this rather than inherit it.

**Decision: `updateWhere` must not touch `stale` at all.** A partial patch is not a refetch, so it
has no business resolving "the server has changes you haven't seen." `fetch` already clears
`stale` (`scopedQuery.ts:112`) when it writes authoritative *full* data — which is the only place
that claim is true. This supersedes the `staleReason` tracking (Option A) an earlier draft
proposed: it is strictly simpler and needs no new field.

Re-examining the supposed cost of this — a redundant GET per patched scope — it mostly does not
exist:

- On a reorder event **nothing marks the list caches stale**; only `agendaRemindersQuery` is
  invalidated. So `stale` is already `false`, and `fetchIfStale` short-circuits on cache whether
  or not `updateWhere` clears it. The GET-free property survives.
- Where an entry **is** stale, the refetch is *correct* — there is genuinely unseen server state.

**Verify, don't assume:** the reorder suite already asserts "no GET" with live listeners mounted.
Removing the `stale` write must keep those tests green; that is the acceptance check, not this
argument. **Audit every `updateWhere` caller** (mutation paths patch with authoritative server
responses and may rely on current behavior).

### Ordering coupling — verify before preserving

`useSSE.onListEvent` fans each event to the list handler, then agenda, then dashboard. A code
comment claims the list handler must run first because its `updateWhere` clears `stale`, letting
the agenda's `fetchIfStale` resolve from cache — and that this is what keeps reorder GET-free.

Per the analysis above **that claim looks wrong**: nothing marks the list caches stale on a
reorder event, so the agenda's `fetchIfStale` resolves from cache regardless of ordering. If
removing the `stale` write keeps the no-GET tests green, the coupling is not load-bearing and the
comment must be corrected rather than preserved — an inaccurate comment on shared infrastructure
is worse than none. Confirm empirically; do not delete the comment on the strength of this
paragraph alone.

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

---

## Deviations from this design (as shipped)

Recorded so the next reader trusts the code over the plan.

- **Phase 3 asked for a "bounded retry/backoff"; only the backoff shipped — deliberately.** A
  bound was implemented first (3 attempts) and rejected in review: when the refresh keeps
  succeeding but the stream keeps being rejected, `/login` never fires and the cap leaves an app
  that looks live while receiving nothing, recoverable only by a reload. A toast was tried and
  rejected too — toasts auto-dismiss in 4s, which is the wrong vehicle for a permanent
  condition. Shipped instead: exponential backoff, 1s → 30s cap, retried indefinitely. There is
  no dead state left to notify anyone about. No jitter (a household cannot thunder).
- **The resync-on-reconnect requirement was missed by this design entirely.** Phase 1 assumed
  "EventSource reconnects, sends `Last-Event-ID`, the server resyncs — the existing, already-working
  recovery path". True of the *browser's* auto-retry; false of Phase 3's reconnect, which builds a
  **fresh** `EventSource` whose empty last-event-id means no header and therefore no server
  resync. Phase 3 would have silently voided Phase 1's guarantee — and Phase 2's patching is
  exactly what makes that fatal rather than merely stale. The client now requests the resync
  itself on `connected`. Found in review, not in testing.
- **The ordering coupling is real but not for the reason assumed.** "Verify before preserving"
  was the right instinct. The agenda's fetcher reads the list **summaries** cache synchronously;
  the per-list *detail* fetches sit behind an `await` and are order-insensitive. The event that
  actually breaks is `list.deleted` (agenda-first reads the deleted list from summaries, then
  GETs a dead id → 404), not the `list.item.checked` the test pins.
- **`updateWhere`/`stale` Option A (a `staleReason` field) was superseded**, as noted inline: the
  fix is simply that `updateWhere` must not touch `stale` at all.
- **Not verified end-to-end by an agent:** the eviction path and the backoff reconnect have unit
  coverage but were never exercised against a live multi-tab browser session. The two-tab
  one-way-update bug that prompted this work was never root-caused; the eviction fix is a
  plausible cause, not a proven one.
