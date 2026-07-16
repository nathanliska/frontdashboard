# SSE Hardening Implementation Plan

**Status:** ✅ Shipped 2026-07-16 (`44a9e15`, `8f2028f`, `6fd1f31`). Tasks 1-8 all landed; see the
design doc's "Deviations from this design (as shipped)" for where the code differs from these
tasks (notably Task 6: the retry cap described here was replaced by unbounded backoff, and the
resync-on-reconnect requirement was found in review and is absent from these steps).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SSE delivery loss detectable (finding #8), then stop the hot list events from forcing every observing client to refetch an entire list to learn one field changed.

**Architecture:** Phase 1 makes an evicted client resync instead of going silently deaf, which is the prerequisite for trusting patches. Phase 2 then adds the new field values to the `update_item` event payload and patches the cache in place — the same payload-carrying pattern the shipped reorder work proved — plus a correctness fix so a patch no longer erases the record of a missed event.

**Tech Stack:** FastAPI + SQLAlchemy async + sse-starlette (backend); React 19 + TS + Vitest (frontend).

**Spec:** `docs/shipped/sse-hardening-design.md`. Read it for rationale; this plan is the how.

## Global Constraints

- **Phase 1 (Tasks 1–2) MUST land before Phase 2 (Tasks 3–6).** Patching is only safe once a client can tell it missed events. Do not reorder.
- **DO NOT COMMIT.** Commits are held for a batch review by the maintainer. Leave work in the working tree; do not run `git commit`, `git reset`, or `git stash`.
- **Do not touch** `.github/dependabot.yml`, `.gitignore`, `backend/pyproject.toml`, `backend/uv.lock` — unrelated in-progress user work.
- Backend: every non-GET route needs `_csrf: None = Depends(require_csrf)`; build the SSE event dict **before** `db.commit()` and broadcast **after**; `role is None` means owner.
- Backend commands run from `backend/` with `uv run`. Docker IS available (Testcontainers). `make test` runs pytest **and** `ty`; both must pass.
- Frontend: `apiFetch`/`requestVoid` only; errors are `ApiError`. List data lives in `resources/*` scoped caches, not Zustand. Vitest default env is **node** — DOM tests need `// @vitest-environment jsdom` on line 1. Mocks use `vi.hoisted` + `vi.mock`. Reset caches with `__resetListDataForTests()`.
- **A "no GET" assertion is vacuous without a live listener mounted** — `invalidateWhere` defaults to `activeOnly: true` and skips the fetch when `listeners.size === 0`. Follow the existing probe-component pattern in `frontend/src/resources/listData.reorder.test.tsx`.
- **Known pre-existing flake:** the backend suite fails ~1 in 3–4 full runs on a *random* unrelated test with auth `"Invalid token"` errors. Verified at clean baseline without these changes. If you hit it, re-run; do not chase or "fix" it. Report if seen.

---

## File Structure

**Phase 1 — delivery loss detectable (#8)**
- Modify `backend/app/sse/manager.py` — eviction enqueues a close sentinel instead of silently dropping the client; export the sentinel.
- Modify `backend/app/routers/sse.py` — extract the stream generator to a module-level, directly-testable function that ends the stream on the sentinel.
- Modify `backend/tests/test_sse.py` — drive the generator directly (the ASGI client cannot close infinite generators).

**Phase 2 — payload-carrying hot events**
- Modify `frontend/src/resources/scopedQuery.ts` — `updateWhere` stops clearing `stale`.
- Modify `frontend/src/hooks/useSSE.ts` — correct the ordering comment **iff** Task 3 proves it non-load-bearing.
- Modify `backend/app/routers/lists.py` — `update_item` payload carries `values`.
- Modify `backend/tests/test_lists.py` — assert the payload shape.
- Modify `frontend/src/resources/listData.ts` — patch the item in place from `values`.
- Modify `frontend/src/resources/listData.reorder.test.tsx` (or a new `listData.patch.test.tsx`) — assert patch + no GET + divergence fallback.

**Docs (final task)**
- `docs/shipped/sse-hardening-design.md` → status, and move to `docs/shipped/` if fully done.
- `docs/references/review-findings.md` — #8 disposition + changelog.
- `CONTEXT.md` — current behavior.

---

## Task 1: Evicted clients get a close sentinel instead of silence

**Files:**
- Modify: `backend/app/sse/manager.py`
- Test: `backend/tests/test_sse.py`

**Interfaces:**
- Produces: `CLOSED_SENTINEL` (module-level, exported from `app.sse.manager`). On `QueueFull`, `broadcast` drains that client's backlog, enqueues `CLOSED_SENTINEL`, and removes it from `_clients`.

**Why:** today `broadcast` calls `self.disconnect(client)` on `QueueFull` and sends the client nothing, while its HTTP response stays open. The generator only ever `continue`s on timeout, so it never notices — the client receives nothing forever and never reconnects, so `EventSource`'s reconnect and the working `Last-Event-ID`→`resync` path never fire. The comment claiming the generator "detects closure" is false and must go.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_sse.py`:

```python
@pytest.mark.asyncio
async def test_evicted_client_receives_close_sentinel() -> None:
    """A client too far behind is told to resync, not silently dropped."""
    from app.sse.manager import CLOSED_SENTINEL, SseManager, _QUEUE_MAX

    mgr = SseManager()
    user_id = uuid.uuid4()
    client = mgr.connect(user_id)

    # Fill the queue to capacity so the next broadcast evicts.
    for _ in range(_QUEUE_MAX):
        client.queue.put_nowait({"event": "filler", "data": "{}"})

    await mgr.broadcast({"event": "list.updated", "data": "{}"}, user_ids={user_id}, actor_id=user_id)

    # Evicted from the registry...
    assert client not in mgr._clients
    # ...and the backlog is replaced by a single close sentinel it will actually see.
    assert client.queue.qsize() == 1
    assert client.queue.get_nowait() is CLOSED_SENTINEL
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_sse.py::test_evicted_client_receives_close_sentinel -v`
Expected: FAIL — `ImportError: cannot import name 'CLOSED_SENTINEL'`.

- [ ] **Step 3: Implement** — in `backend/app/sse/manager.py`:

Add the sentinel near `_QUEUE_MAX`:

```python
_QUEUE_MAX = 256

# Pushed onto a client's queue when it is evicted for falling too far behind.
# The stream generator ends the response on this, so the browser's EventSource
# reconnects and the Last-Event-ID -> resync path restores consistency.
CLOSED_SENTINEL = object()
```

Replace the `except asyncio.QueueFull` branch in `broadcast` (delete the false comment about the generator detecting closure):

```python
            try:
                client.queue.put_nowait(message)
            except asyncio.QueueFull:
                # Too far behind to catch up: drop the backlog and leave only a
                # close sentinel, so the generator ends the stream and the client
                # reconnects + resyncs instead of silently receiving nothing.
                while not client.queue.empty():
                    with contextlib.suppress(asyncio.QueueEmpty):
                        client.queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    client.queue.put_nowait(CLOSED_SENTINEL)
                self.disconnect(client)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_sse.py -v`
Expected: PASS — the new test plus all existing SSE tests (including `test_manager_multiple_connections_same_user` and `test_manager_disconnect_idempotent`).

- [ ] **Step 5: Lint**

Run: `cd backend && uv run ruff check --fix && uv run ruff format && uv run ty check`
Expected: all clean. (If `ty` objects to `object()` in the untyped `asyncio.Queue`, keep the queue untyped rather than widening its type — report if you must deviate.)

- [ ] **Step 6: DO NOT COMMIT.** Report.

---

## Task 2: The stream ends on the sentinel and tells the client to resync

**Files:**
- Modify: `backend/app/routers/sse.py`
- Test: `backend/tests/test_sse.py`

**Interfaces:**
- Consumes: `CLOSED_SENTINEL`, `manager`, `_Client` from `app.sse.manager`.
- Produces: `stream_events(client: _Client, *, send_resync: bool) -> AsyncGenerator[dict, None]` — module-level so tests can drive it without the ASGI transport. `sse_stream` delegates to it.

**Why testable-by-extraction:** `backend/tests/test_sse.py:149-154` states the streaming pipeline is untested because httpx's ASGI transport cannot cleanly close infinite SSE generators — which is exactly why this bug survived. Extracting the generator lets tests drive it directly, no transport involved.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_sse.py`:

```python
@pytest.mark.asyncio
async def test_stream_ends_with_resync_on_close_sentinel() -> None:
    """An evicted stream yields resync and terminates rather than hanging."""
    from app.routers.sse import stream_events
    from app.sse.manager import CLOSED_SENTINEL, SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())

    gen = stream_events(client, send_resync=False)
    first = await gen.__anext__()
    assert first["event"] == "connected"

    client.queue.put_nowait({"event": "list.updated", "data": "{}"})
    assert (await gen.__anext__())["event"] == "list.updated"

    client.queue.put_nowait(CLOSED_SENTINEL)
    assert (await gen.__anext__())["event"] == "resync"

    with pytest.raises(StopAsyncIteration):
        await gen.__anext__()


@pytest.mark.asyncio
async def test_stream_sends_resync_first_on_reconnect() -> None:
    """send_resync=True (Last-Event-ID present) replays a resync up front."""
    from app.routers.sse import stream_events
    from app.sse.manager import SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())

    gen = stream_events(client, send_resync=True)
    assert (await gen.__anext__())["event"] == "connected"
    assert (await gen.__anext__())["event"] == "resync"
    await gen.aclose()
```

> `stream_events` must reference the module-level `manager` singleton in its `finally` (matching current behavior). These tests build their own `SseManager`, so the `finally`'s `manager.disconnect(client)` is a harmless no-op on an unknown client — `disconnect` already suppresses `ValueError`. Do not add a manager parameter just for tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_sse.py -k stream_ -v`
Expected: FAIL — `ImportError: cannot import name 'stream_events'`.

- [ ] **Step 3: Implement** — rewrite `backend/app/routers/sse.py`'s generator as a module-level function and delegate to it:

```python
async def stream_events(client: _Client, *, send_resync: bool) -> AsyncGenerator[dict, None]:
    """Yield SSE frames for one connection until it closes or is evicted.

    Module-level (rather than nested in the route) so tests can drive it directly:
    httpx's ASGI transport cannot cleanly close an infinite SSE generator.
    """
    try:
        yield connected_dict()

        if send_resync:
            yield resync_dict()

        while True:
            try:
                msg = await asyncio.wait_for(client.queue.get(), timeout=5.0)
            except TimeoutError:
                # No event in the last 5s — loop. sse-starlette's ping=25 sends
                # keepalive comments independently.
                continue

            if msg is CLOSED_SENTINEL:
                # Evicted for falling behind: tell the client to resync and end the
                # response. EventSource reconnects and re-syncs from Last-Event-ID.
                yield resync_dict()
                return

            yield msg
    finally:
        manager.disconnect(client)


@router.get("")
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user_for_stream),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    send_resync = _should_resync_on_connect(request.headers.get("last-event-id"))
    client = manager.connect(current_user.id)
    return EventSourceResponse(stream_events(client, send_resync=send_resync), ping=25)
```

Update the imports at the top of the file:

```python
from app.sse.manager import CLOSED_SENTINEL, _Client, manager
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_sse.py -v`
Expected: PASS — all SSE tests.

- [ ] **Step 5: Full backend gate**

Run: `cd backend && uv run pytest -q && uv run ty check && uv run ruff check --fix && uv run ruff format`
Expected: all pass (re-run once if you hit the known random flake).

- [ ] **Step 6: DO NOT COMMIT.** Report — Phase 1 is complete; Phase 2 may now proceed.

---

## Task 3: A patch must not clear `stale`

**Files:**
- Modify: `frontend/src/resources/scopedQuery.ts`
- Modify: `frontend/src/hooks/useSSE.ts` (comment only, and only if Step 4 proves it)
- Test: `frontend/src/resources/scopedQuery.test.ts` (create if absent)

**Interfaces:**
- Changes `updateWhere` semantics: it patches state and leaves `entry.stale` untouched. `fetch` remains the only place that clears `stale`.

**Why:** `updateWhere` currently sets `entry.stale = false`. An entry marked stale by an `invalidateWhere` that skipped its fetch (no live listeners, `activeOnly: true`) is silently marked fresh again by the next patch — the missed update is then lost until a resync. Phase 2 multiplies patching events, so this must be fixed first. A partial patch is not a refetch.

- [ ] **Step 1: Write the failing test** — `frontend/src/resources/scopedQuery.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createScopedQuery } from './scopedQuery'

type Scope = { id: string }

function makeQuery(fetcher: (scope: Scope) => Promise<string>) {
  return createScopedQuery<Scope, string>({ getKey: (s) => s.id, fetcher })
}

describe('updateWhere and stale', () => {
  it('does not clear staleness recorded by an invalidate whose fetch was skipped', async () => {
    const fetcher = vi.fn().mockResolvedValue('server-1')
    const q = makeQuery(fetcher)

    // Seed the cache (one fetch).
    await q.fetchIfStale({ id: 'a' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A missed event: no listeners are mounted, so invalidateWhere marks the entry
    // stale but skips the fetch (activeOnly defaults to true).
    q.invalidateWhere((s) => s.id === 'a')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // A patch arrives for the same scope. It must NOT erase the record that we
    // still owe the server a refetch.
    q.updateWhere(
      (s) => s.id === 'a',
      (state) => ({ ...state, data: 'patched' }),
    )
    expect(q.getState({ id: 'a' }).data).toBe('patched')

    // The outstanding invalidate must still cause a refetch.
    fetcher.mockResolvedValue('server-2')
    await q.fetchIfStale({ id: 'a' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(q.getState({ id: 'a' }).data).toBe('server-2')
  })

  it('a patch alone does not trigger a refetch', async () => {
    const fetcher = vi.fn().mockResolvedValue('server-1')
    const q = makeQuery(fetcher)

    await q.fetchIfStale({ id: 'b' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    q.updateWhere(
      (s) => s.id === 'b',
      (state) => ({ ...state, data: 'patched' }),
    )

    // Nothing marked it stale, so this resolves from cache — no second GET.
    await q.fetchIfStale({ id: 'b' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(q.getState({ id: 'b' }).data).toBe('patched')
  })
})
```

- [ ] **Step 2: Run test to verify the first case fails**

Run: `cd frontend && npx vitest run src/resources/scopedQuery.test.ts`
Expected: the first test FAILS (`expected 2, got 1` — `updateWhere` cleared `stale`, so `fetchIfStale` resolved from cache). The second test passes already.

- [ ] **Step 3: Implement** — in `frontend/src/resources/scopedQuery.ts`, delete the `entry.stale = false` line from `updateWhere` and replace the comment block above it:

```ts
  function updateWhere(
    predicate: (scope: Scope) => boolean,
    updater: (state: ScopedQueryState<Data>, scope: Scope) => ScopedQueryState<Data>,
  ): void {
    for (const entry of entries.values()) {
      if (!predicate(entry.scope)) continue
      // Deliberately does not touch `stale`. A patch writes part of an entry; it is not a
      // refetch, so it cannot resolve "the server has changes we haven't seen". Only fetch()
      // clears `stale`, because only fetch() writes authoritative full data. Clearing it here
      // would silently discard an invalidate whose fetch was skipped for lack of listeners,
      // losing that update until a resync.
      setState(entry, updater(entry.state, entry.scope))
    }
  }
```

- [ ] **Step 4: Run tests and check the coupling claim**

Run: `cd frontend && npx vitest run src/resources/`
Expected: PASS — both new tests **and** every existing reorder test, including the "no GET" assertions in `listData.reorder.test.tsx`.

**This is the load-bearing check.** The comment in `frontend/src/hooks/useSSE.ts` `onListEvent` claims the list handler must run before the agenda handler *because* `updateWhere` clears `stale`, and that this is what keeps reorder GET-free. If the no-GET tests still pass with the `stale` write removed, that claim is false — nothing marks the list caches stale on a reorder event, so the agenda's `fetchIfStale` resolves from cache regardless of ordering.

- If the no-GET tests **pass**: correct the comment (do not delete the ordering itself; just stop justifying it with a false mechanism):

```ts
        // handleListResourceEvent runs first by convention: it applies the authoritative list
        // state from the event, so the agenda handler (which invalidates agenda reminders for
        // every list.* event and re-derives from the list caches) sees patched data rather than
        // stale data in the same tick.
```

- If any no-GET test **fails**: STOP and report. The coupling is real, the design's analysis is wrong, and this needs a decision rather than a workaround.

- [ ] **Step 5: Audit the other callers**

Run: `cd frontend && grep -rn "updateWhere" src/`
Every caller now leaves `stale` alone. Confirm none depended on a patch clearing staleness (the mutation paths in `resources/listData.ts` and `resources/calendarData.ts` patch with authoritative server responses; leaving a genuine stale flag set only means a later `fetchIfStale` refetches, which is correct). Note anything suspicious in your report rather than "fixing" it.

- [ ] **Step 6: Full frontend gate**

Run: `cd frontend && npx vitest run src/ && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: DO NOT COMMIT.** Report, including whether the coupling proved load-bearing.

---

## Task 4: `update_item` events carry the new values

**Files:**
- Modify: `backend/app/routers/lists.py` (`update_item`)
- Test: `backend/tests/test_lists.py`

**Interfaces:**
- Produces: `list.item.checked` / `list.item.updated` payloads gain `values` — a JSON-safe mapping of exactly the fields the client changed to their new values, e.g. `{"list_id": "...", "dashboard_id": "...", "fields": ["checked"], "values": {"checked": true}}`.

**Why:** the payload currently says *which* fields changed and never their values, so every observing client must GET the whole list detail to learn one boolean. One route serves both event types, so one change covers both.

**Serialisation:** derive values from `ListItemResponse` with `mode="json"` so `due_date` (date → ISO string), `priority` (enum → string) and `assigned_to` (UUID → string) match the frontend's `ListItem` types exactly, and the payload cannot drift from the response DTO.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_lists.py` (follow that file's existing fixtures and its `ActivityEvent` query style; `backend/tests/test_lists_reorder.py` has examples of asserting the latest event):

```python
async def test_item_update_event_payload_carries_new_values(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Observers must be able to apply the change without refetching the list."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"], text="original")

    set_csrf(auth_client)
    resp = await auth_client.patch(
        f"/api/lists/{lst['id']}/items/{item['id']}",
        json={"checked": True},
    )
    assert resp.status_code == 200

    result = await db_session.execute(
        select(ActivityEvent).order_by(ActivityEvent.event_id.desc()).limit(1)
    )
    event = result.scalar_one()
    assert event.event_type == EventType.list_item_checked
    assert event.payload["fields"] == ["checked"]
    assert event.payload["values"] == {"checked": True}


async def test_item_update_event_values_are_json_safe(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """due_date/priority serialise to the same shapes the API returns."""
    dashboard = await create_dashboard(auth_client)
    lst = await create_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"], text="original")

    set_csrf(auth_client)
    resp = await auth_client.patch(
        f"/api/lists/{lst['id']}/items/{item['id']}",
        json={"text": "renamed", "due_date": "2026-08-01", "priority": "high"},
    )
    assert resp.status_code == 200

    result = await db_session.execute(
        select(ActivityEvent).order_by(ActivityEvent.event_id.desc()).limit(1)
    )
    event = result.scalar_one()
    assert event.event_type == EventType.list_item_updated
    assert event.payload["values"] == {
        "text": "renamed",
        "due_date": "2026-08-01",
        "priority": "high",
    }
    # Only the submitted fields are echoed.
    assert set(event.payload["values"]) == set(event.payload["fields"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_lists.py -k item_update_event -v`
Expected: FAIL — `KeyError: 'values'`.

- [ ] **Step 3: Implement** — in `update_item` in `backend/app/routers/lists.py`, build `values` from the refreshed item and add it to the payload. The item is mutated before the event is built, so serialise after `setattr` and before the event:

```python
    for field in body.model_fields_set:
        setattr(item, field, getattr(body, field))
    item.updated_by = current_user.id

    # Carry the new values so observers can patch their cache instead of refetching
    # the whole list. Derived from ListItemResponse so the wire shapes cannot drift
    # from the REST DTO (date -> ISO string, enum -> str, UUID -> str).
    await db.flush()
    serialised_item = ListItemResponse.model_validate(item).model_dump(mode="json")
    changed_values = {field: serialised_item[field] for field in body.model_fields_set if field in serialised_item}

    event_message = await _build_list_event_message(
        db,
        event_type=EventType.list_item_checked if "checked" in body.model_fields_set else EventType.list_item_updated,
        current_user=current_user,
        dashboard=dashboard,
        entity_type="list_item",
        entity_id=item.id,
        payload={"list_id": str(list_id), "fields": list(body.model_fields_set), "values": changed_values},
        client_mutation_id=client_mutation_id,
    )
```

> `_build_list_event_message` already flushes; the extra `await db.flush()` before serialising is deliberate so the ORM object reflects the assignment. If `model_validate` on the pending instance misbehaves, report rather than reaching for `db.refresh` (which would round-trip mid-transaction).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_lists.py tests/test_lists_reorder.py -v`
Expected: PASS.

- [ ] **Step 5: Full backend gate**

Run: `cd backend && uv run pytest -q && uv run ty check && uv run ruff check --fix && uv run ruff format`
Expected: all pass.

- [ ] **Step 6: DO NOT COMMIT.** Report.

---

## Task 5: Patch list items in place from the event payload

**Files:**
- Modify: `frontend/src/resources/listData.ts`
- Test: `frontend/src/resources/listData.patch.test.tsx` (new)

**Interfaces:**
- Consumes: `values` on `list.item.checked` / `list.item.updated` payloads (Task 4); `orderByIds`-style divergence handling; `patchListDetailById`.
- Changes `handleListResourceEvent`: `list.item.checked` and `list.item.updated` patch the item in cache instead of invalidating.

- [ ] **Step 1: Write the failing test** — `frontend/src/resources/listData.patch.test.tsx`. Model it on `listData.reorder.test.tsx`: same `vi.hoisted` mocks, the same **rendered probe component** so listeners are live (a no-GET assertion without a mounted listener is vacuous — `invalidateWhere` skips the fetch when `listeners.size === 0`), and `__seedListDetailForTests`.

Required cases:
1. A `list.item.checked` event from **another actor** carrying `values: {checked: true}` flips that item in the cache and issues **no GET** (assert the mocked `apiGetList` was never called).
2. A `list.item.updated` event carrying `values: {text: 'renamed'}` updates that item's text, no GET.
3. **Divergence:** an event whose `entity_id` is not in the cached detail triggers exactly **one** refetch.
4. **Back-compat:** an event with **no** `values` key falls back to invalidate-and-refetch (exactly one GET) rather than silently doing nothing.
5. A self-echoed event (matching `client_mutation_id`, own `actor_id`) is still suppressed and does not double-apply.

Derive expectations from the required behavior, not from whatever the implementation happens to produce.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/resources/listData.patch.test.tsx`
Expected: FAIL — cases 1 and 2 currently issue a GET.

- [ ] **Step 3: Implement** — in `handleListResourceEvent` in `frontend/src/resources/listData.ts`, add a branch for the two item-update events **after** the `consumePendingListMutationEcho` early-return and alongside the existing reorder branches:

```ts
  if (event.event_type === 'list.item.checked' || event.event_type === 'list.item.updated') {
    const payload = getEventPayload(event)
    const values = payload?.values
    const itemId = event.entity_id
    // Only patch when the event carries the new values; otherwise fall through to
    // invalidate-and-refetch so an older/unknown payload still converges.
    if (affectedListId && values && typeof values === 'object' && !Array.isArray(values)) {
      let diverged = false
      patchListDetailById(affectedListId, (detail) => {
        if (!detail.items.some((item) => item.id === itemId)) {
          diverged = true
          return detail
        }
        return {
          ...detail,
          items: detail.items.map((item) =>
            item.id === itemId ? { ...item, ...(values as Partial<ListItem>) } : item,
          ),
        }
      })
      if (diverged) {
        listDetailQuery.invalidateWhere((scope) => scope.listId === affectedListId)
      }
      return
    }
  }
```

> Placement matters: this must sit after the echo-suppression return (so the actor's own optimistic state isn't re-applied) and before the generic `invalidateWhere` tail. Falling through when `values` is absent is deliberate — it keeps the old refetch behavior as the safety net.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/resources/`
Expected: PASS — the new file plus every existing listData/reorder test.

- [ ] **Step 5: Full frontend gate**

Run: `cd frontend && npx vitest run src/ && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: DO NOT COMMIT.** Report.

---

## Task 6: `useSSE` survives an auth rejection (Phase 3)

**Files:**
- Modify: `frontend/src/api/client.ts` (export `tryRefresh`)
- Modify: `frontend/src/hooks/useSSE.ts`
- Test: `frontend/src/hooks/useSSE.test.tsx` (new, jsdom)

**Interfaces:**
- Produces: `export function tryRefresh(): Promise<boolean>` from `frontend/src/api/client.ts` (already exists as a module-private single-flight; just export it — do NOT duplicate the logic).
- `useSSE` gains an `onerror` handler: `CLOSED` → refresh → reconnect, or redirect to `/login`.

**Why:** `useSSE` has no `onerror` handler at all. `EventSource` auto-retries **network** drops (`readyState === CONNECTING`) but per the HTML spec **fails permanently on an HTTP error status** like 401 (`readyState === CLOSED`, no retry). `apiFetch`'s 401-refresh can't help — that's `fetch`, a different API. So an auth-rejected stream silently kills real-time updates for that tab until reload. `readyState` is the discriminator the missing status code denies us.

- [ ] **Step 1: Write the failing test** — `frontend/src/hooks/useSSE.test.tsx`, line 1 `// @vitest-environment jsdom`. jsdom has no `EventSource`, so install a controllable fake on `globalThis` (capture instances; expose `readyState`, `onerror`, `addEventListener`, `close`). Mock `../api/client`'s `tryRefresh` with `vi.hoisted` + `vi.mock`, and mock the auth store so a user is present.

Required cases:
1. `onerror` with `readyState === EventSource.CONNECTING` → `tryRefresh` NOT called, no new EventSource (the browser is already retrying a transient drop).
2. `onerror` with `readyState === EventSource.CLOSED` and `tryRefresh` resolving `true` → a NEW EventSource is constructed (reconnect).
3. `onerror` with `CLOSED` and `tryRefresh` resolving `false` → navigates to `/login`, no reconnect loop.
4. Repeated `CLOSED` errors do not reconnect unboundedly — assert the bounded retry/backoff holds (e.g. attempts stop at the cap).
Derive expectations from this required behavior, not from whatever the implementation emits.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useSSE.test.tsx`
Expected: FAIL — no `onerror` handler exists, so nothing is called.

- [ ] **Step 3: Export the refresh** — in `frontend/src/api/client.ts`, change `function tryRefresh()` to `export function tryRefresh()`. Do not otherwise alter it: its module-level `refreshPromise` single-flight is exactly why SSE must share it rather than race a second refresh.

- [ ] **Step 4: Implement** — in `frontend/src/hooks/useSSE.ts`, inside the effect. Reconnect by bumping a nonce that the effect depends on, so teardown/recreate goes through the existing cleanup path:

```ts
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const authRetriesRef = useRef(0)
  // ... inside the effect, after `const es = new EventSource(...)`:

    es.onerror = () => {
      // EventSource retries transient network drops itself (readyState CONNECTING).
      // It does NOT retry after an HTTP error status: the spec fails the connection
      // and sets CLOSED. That is our only signal that auth, not the network, is the
      // problem — the error event carries no status code.
      if (es.readyState !== EventSource.CLOSED) return
      if (authRetriesRef.current >= MAX_SSE_AUTH_RETRIES) return

      authRetriesRef.current += 1
      void tryRefresh().then((ok) => {
        if (!ok) {
          window.location.replace('/login')
          return
        }
        setReconnectNonce((n) => n + 1)
      })
    }
```

Add `const MAX_SSE_AUTH_RETRIES = 3` at module level, add `reconnectNonce` to the effect's dependency array, and reset `authRetriesRef.current = 0` once a stream connects successfully (the `connected` event is the natural signal) so a long-lived session isn't permanently capped.

> Keep `es.close()` in the cleanup. Do not remove the existing listener registrations or the handler-call ordering in `onListEvent`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/ && npx vitest run src/ && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: DO NOT COMMIT.** Report.

---

## Task 7: `stream_events` deregisters against the client's own manager

**Files:**
- Modify: `backend/app/sse/manager.py` (or `backend/app/routers/sse.py`)
- Test: `backend/tests/test_sse.py`

**Why:** `stream_events`' `finally` calls the module-level `manager` singleton, but `client` is a parameter that may belong to any `SseManager`. Harmless in production (one manager), but it means the new tests — which build local `SseManager()` instances — silently do **not** verify that the generator deregisters its client (`disconnect` swallows the `ValueError`). Since "extract it so it's testable" was the whole rationale for hoisting `stream_events`, this undercuts half the point.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_sse.py`:

```python
@pytest.mark.asyncio
async def test_stream_deregisters_client_from_its_own_manager() -> None:
    """Closing the stream removes the client from the manager that created it."""
    from app.routers.sse import stream_events
    from app.sse.manager import SseManager

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4())
    assert client in mgr._clients

    gen = stream_events(client, send_resync=False)
    await gen.__anext__()  # 'connected'
    await gen.aclose()

    assert client not in mgr._clients
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_sse.py -k deregisters -v`
Expected: FAIL — the `finally` disconnects from the global singleton, so the local manager still holds the client.

- [ ] **Step 3: Implement** — give `_Client` a reference to its owning manager so the generator can clean up against the right one, without adding a test-only parameter. In `backend/app/sse/manager.py`:

```python
@dataclass
class _Client:
    user_id: uuid.UUID
    manager: "SseManager"
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_QUEUE_MAX))
```

and in `SseManager.connect`:

```python
    def connect(self, user_id: uuid.UUID) -> _Client:
        """Register a new SSE connection and return its client handle."""
        client = _Client(user_id=user_id, manager=self)
        self._clients.append(client)
        return client
```

Then in `backend/app/routers/sse.py`, change the generator's cleanup to `client.manager.disconnect(client)` and drop the now-unused `manager` import if nothing else in the module uses it (`sse_stream` still calls `manager.connect`, so it likely stays).

> Use a string annotation (`"SseManager"`) for the forward reference; `_Client` is declared above the class. If `ty` objects, add `from __future__ import annotations` at the top of the module rather than restructuring.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_sse.py -v`
Expected: PASS — all SSE tests, including the eviction and termination tests from Tasks 1–2.

- [ ] **Step 5: Full backend gate**

Run: `cd backend && uv run pytest -q && uv run ty check && uv run ruff check --fix && uv run ruff format`
Expected: all pass (re-run once if you hit the known random flake).

- [ ] **Step 6: DO NOT COMMIT.** Report.

---

## Task 8: Pin the `useSSE` handler ordering with a test

**Files:**
- Test: `frontend/src/hooks/useSSE.test.tsx` (extend the file created in Task 6)

**Why:** the final review established that the list handler genuinely must run before the agenda handler — but for a subtler reason than the old (deleted) comment claimed: `agendaRemindersQuery.invalidateWhere` invokes its fetcher **synchronously**, so `fetchAgendaReminders` → `loadDashboardListDetails` → `listDetailQuery.fetchIfStale` reads the list cache **in the same tick**. If the agenda handler ran first, it would re-derive from unpatched list data. Nothing pins this: reordering two lines in `onListEvent` would silently reintroduce wrong agenda data (and GETs), with every existing test still green.

- [ ] **Step 1: Write the failing test** — extend `frontend/src/hooks/useSSE.test.tsx`. Mock `../resources/listData` and `../resources/agendaData` with `vi.hoisted` + `vi.mock`, recording call order into a shared array. Dispatch a `list.item.checked` message through the fake EventSource, then assert the recorded order is `['list', 'agenda']`.

```ts
const calls: string[] = []
// in the mocks: handleListResourceEvent: vi.fn(() => { calls.push('list') })
//               handleAgendaResourceEvent: vi.fn(() => { calls.push('agenda') })

it('routes list events to the list handler before the agenda handler', () => {
  // render the hook, dispatch a list.item.checked event through the fake EventSource
  expect(calls).toEqual(['list', 'agenda'])
})
```

Give the test a comment naming WHY the order matters (agenda re-derives from the list caches synchronously in the same tick), so the next person who trips it understands the constraint rather than deleting the test.

- [ ] **Step 2: Verify the test has teeth**

Temporarily swap the two calls in `onListEvent` and re-run: the test must FAIL. Restore the correct order. State this RED evidence in your report — a test that passes in both orders pins nothing.

- [ ] **Step 3: Run**

Run: `cd frontend && npx vitest run src/ && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 4: DO NOT COMMIT.** Report.

---

## Task 9: Verification + docs/tracker

**Files:**
- Modify: `docs/references/review-findings.md`, `CONTEXT.md`, `docs/shipped/sse-hardening-design.md`

- [ ] **Step 1: Full gate**

Run: `make test && make lint`
Expected: backend pytest + `ty`, frontend vitest + typecheck, ruff + biome all pass. Re-run once if you hit the known random auth flake; report if seen.

- [ ] **Step 2: Manual two-browser check (maintainer)** — this cannot be done by an agent in a non-interactive session. Leave it for the maintainer and say so plainly in your report. What to verify: with a shared dashboard open in two browsers, check/uncheck an item in one; the other updates **with no `GET /api/lists/...`** in its Network tab (only the SSE frame). Confirm agenda/reminder widgets still reflect due-date and priority edits.

- [ ] **Step 3: Update `docs/references/review-findings.md`** — add a Disposition under `### 8.` and a Changelog entry, in the same change (per the protocol at the top of that file). Use the real commit SHAs once the maintainer commits; if commits are still held, write the date and mark SHAs as pending rather than inventing them.

```markdown
- **Disposition** — ✅ Done <DATE> (`<sha>`): eviction now drops the backlog and enqueues a close
  sentinel; the stream generator yields `resync` and ends the response, so an evicted client
  reconnects and re-syncs via `Last-Event-ID` instead of silently receiving nothing. The
  generator was extracted to a module-level `stream_events(...)` and is now covered directly
  (the ASGI transport cannot close infinite SSE generators, which is why this went untested).
  The false comment claiming the generator detects closure is removed. Authorization bounding
  (expiring a stream when access is revoked mid-connection) remains open.
```

> Read #8's full text before writing this. If its authorization-bounding sub-item is untouched, mark the finding **◐ Partially done**, not ✅ — do not overstate.

Changelog: `- **<DATE>** — SSE hardening: evicted streams now resync instead of going silently deaf (#8); list item check/update events carry their new values so observers patch instead of refetching (`<sha>`).`

- [ ] **Step 4: Update `CONTEXT.md`** — the Lists section currently says "Other list events still invalidate-and-refetch — see `docs/shipped/sse-hardening-design.md`." Update it to state that item check/update events now patch in place too, and that an evicted SSE stream resyncs rather than going silent.

- [ ] **Step 5: Update the design doc** — set status to shipped with SHAs, record any deviations (especially the outcome of Task 3's coupling check), and move it to `docs/shipped/` **only if** both phases fully landed. Note explicitly that finding #21 (durable/multi-process delivery) was deliberately left open.

- [ ] **Step 6: DO NOT COMMIT.** Report; the maintainer batches the commits.

---

## Self-Review notes (addressed)

- **Spec coverage:** Phase 1 #8 sentinel (Task 1) + generator termination/resync and testability-by-extraction (Task 2); Phase 2 `stale` decision and the coupling verification (Task 3), payload `values` with DTO-derived serialisation (Task 4), in-place patch + divergence + back-compat fallback (Task 5), docs/dispositions (Task 6). Explicitly out of scope per the design: #21 multi-process, creates/deletes/shares/layout conversion. ✅
- **Ordering:** Phase 1 (1–2) strictly precedes Phase 2 (3–6); Task 3 precedes Task 5 so patching lands after the `stale` semantics are correct. ✅
- **Type consistency:** `CLOSED_SENTINEL` and `stream_events(client, *, send_resync)` are named identically in Tasks 1, 2 and the tests; `values` keyed by the same field names in Tasks 4 and 5; `ListItem` fields match `ListItemResponse` via `model_dump(mode="json")`. ✅
- **No placeholders:** every code step carries real code; Task 5's tests are specified by required behavior with an explicit warning against enshrining implementation output, and by pattern reference to an existing file rather than a vague "write tests". ✅
