# Security Quick Wins (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review-findings #3, #4, #5 — stop verification-link session replay, make failed list/item deletes actually fail, and reject empty PATCH bodies before auth/mutation.

**Architecture:** Three independent, coherent changes. #3 tightens one backend branch plus a small frontend message. #4 adds a shared `requestVoid` HTTP helper and routes the two DELETE wrappers through it. #5 adds a reusable "reject empty patch" Pydantic base and makes the list-item permission check unconditional.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy 2.0 (async), pytest + Testcontainers (backend); React + TypeScript, Vitest (frontend).

## Global Constraints

- **Confirm with the user before EVERY commit and before EVERY push** (project HARD RULE). The plan's commit steps are checkpoints, not license to commit unattended.
- **Commit straight to `main`**, logical grouped commits (one per task/finding here), Conventional Commit messages, **no `Co-Authored-By`/attribution trailer**.
- **Backend tests require a Docker socket** (Testcontainers spins up `postgres:16-alpine`). Run them with Docker available (`make dev-up` or a running Docker daemon). If Docker is unavailable, write the tests but report them as "written, not run — Docker required."
- Run `make lint` and `make test` before declaring a task done; per the verify skill, also drive the real flow (see each task's Verification).
- **Regression rule (user standing instruction):** if any step reveals that a fix breaks existing legitimate behavior, STOP and ask the user before proceeding.

---

### Task 1: Reject verification-link session replay (#3)

**Files:**
- Modify: `backend/app/routers/auth.py:270-280` (`verify_email`)
- Test: `backend/tests/test_auth.py:91-107` (replace the existing replay test)
- Modify: `frontend/src/pages/VerifyEmailPage.tsx:7-12` (`getVerificationErrorMessage`)
- Test: `frontend/src/pages/VerifyEmailPage.test.tsx` (new)

**Interfaces:**
- Produces: `verify_email` returns `409 Conflict` with `detail="Email already verified. Please sign in."` on a consumed-token replay; unchanged `200` + cookies on first use; unchanged `400` on invalid/expired.
- Produces: exported `getVerificationErrorMessage(err: unknown): string` handling `409`.

**Context:** `verify_email` already row-locks the token (`.with_for_update()`, auth.py:259) and already detects a used token, but on the used branch it still falls through to `_create_session(...)` (line 277), minting a new session. Resend invalidates prior tokens and only issues when unverified (auth.py:294), so once verified no unused token can exist — the sole replay vector is the consumed token itself. True concurrent-row-lock testing is deferred to the #6 phase (which builds separate-session fixtures); the lock already exists here.

- [ ] **Step 1: Replace the replay test (write it failing)**

In `backend/tests/test_auth.py`, delete `test_verify_email_allows_successful_token_replay` (lines 91-107) and add:

```python
async def test_verify_email_rejects_consumed_token_replay(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "replay@example.com", "password": "mypassword", "display_name": "Replay"},
    )
    token = app.state.email_verification_tokens["replay@example.com"]

    first = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert first.status_code == 200
    assert "access_token" in first.cookies

    replay = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert replay.status_code == 409
    assert replay.json()["detail"] == "Email already verified. Please sign in."
    assert "access_token" not in replay.cookies
    assert "refresh_token" not in replay.cookies
    assert "csrf_token" not in replay.cookies
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_auth.py::test_verify_email_rejects_consumed_token_replay -v`
Expected: FAIL — replay currently returns 200 with cookies.

- [ ] **Step 3: Make the replay branch reject without a session**

In `backend/app/routers/auth.py`, replace the block at lines 270-277:

```python
    if token.used_at is not None:
        if user.email_verified_at != token.used_at:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired verification link")
    else:
        token.used_at = now
        user.email_verified_at = now

    await _create_session(user, response, db)
```

with:

```python
    if token.used_at is not None:
        # Replay of an already-consumed link must never mint a new session.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already verified. Please sign in.",
        )

    token.used_at = now
    user.email_verified_at = now
    await _create_session(user, response, db)
```

(The `import` for `status` is already present; `status.HTTP_409_CONFLICT` needs no new import.)

- [ ] **Step 4: Run backend tests for the file**

Run: `cd backend && uv run pytest tests/test_auth.py -v`
Expected: PASS, including the new test and the still-valid `test_verify_email_authenticates_user` and `test_verify_email_rejects_invalidated_token_after_resend`.

- [ ] **Step 5: Write the failing frontend helper test**

Create `frontend/src/pages/VerifyEmailPage.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/auth'
import { getVerificationErrorMessage } from './VerifyEmailPage'

describe('getVerificationErrorMessage', () => {
  it('routes an already-verified 409 to sign in', () => {
    const msg = getVerificationErrorMessage(new ApiError('Email already verified. Please sign in.', 409))
    expect(msg).toBe('Your email is already verified — please sign in below.')
  })

  it('keeps the resend guidance for a 400', () => {
    const msg = getVerificationErrorMessage(new ApiError('bad', 400))
    expect(msg).toBe('That verification link is invalid or expired. Request a new link below.')
  })

  it('falls back to the error message otherwise', () => {
    expect(getVerificationErrorMessage(new Error('boom'))).toBe('boom')
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd frontend && npm test -- VerifyEmailPage`
Expected: FAIL — `getVerificationErrorMessage` is not exported and has no 409 branch.

- [ ] **Step 7: Export the helper and add the 409 branch**

In `frontend/src/pages/VerifyEmailPage.tsx`, replace lines 7-12:

```tsx
function getVerificationErrorMessage(err: unknown) {
  if (err instanceof ApiError && err.status === 400) {
    return 'That verification link is invalid or expired. Request a new link below.'
  }
  return err instanceof Error ? err.message : 'Email verification failed'
}
```

with:

```tsx
export function getVerificationErrorMessage(err: unknown) {
  if (err instanceof ApiError && err.status === 409) {
    return 'Your email is already verified — please sign in below.'
  }
  if (err instanceof ApiError && err.status === 400) {
    return 'That verification link is invalid or expired. Request a new link below.'
  }
  return err instanceof Error ? err.message : 'Email verification failed'
}
```

No other change is needed: on a 409 the existing `.catch` sets `status='idle'` and shows this message, and the page already renders an "Already verified? Sign in" link (lines 112-117).

- [ ] **Step 8: Run frontend test + typecheck + lint**

Run: `cd frontend && npm test -- VerifyEmailPage && npm run lint`
Expected: PASS.

- [ ] **Step 9: Verify the real flow (verify skill)**

With the app running: register → click the verification link once (lands logged in on home) → click the **same** link again → the verify page shows "Your email is already verified — please sign in below." with a working Sign in link, and no session is created.

- [ ] **Step 10: Commit (confirm with user first)**

```bash
git add backend/app/routers/auth.py backend/tests/test_auth.py frontend/src/pages/VerifyEmailPage.tsx frontend/src/pages/VerifyEmailPage.test.tsx
git commit -m "fix(auth): reject consumed verification links instead of minting a session"
```

---

### Task 2: Treat failed list/item DELETEs as failures (#4)

**Files:**
- Create: `frontend/src/api/http.ts`
- Modify: `frontend/src/api/auth.ts:20-33` (remove local `ApiError`/`readError`, re-export from `http`)
- Modify: `frontend/src/api/lists.ts:121-126,157-166` (route DELETEs through `requestVoid`)
- Test: `frontend/src/api/http.test.ts` (new)
- Test: `frontend/src/api/lists.test.ts` (new)

**Interfaces:**
- Produces: `requestVoid(path: string, init: RequestInit, fallback: string): Promise<void>` — resolves on 2xx (incl. 204), rejects `ApiError` on non-2xx.
- Produces: `ApiError` and `readError` now live in `http.ts`; `auth.ts` re-exports `ApiError` so existing importers (`VerifyEmailPage`) are unaffected.
- Consumes (Task 1): `ApiError` from `../api/auth` still resolves.

**Context:** `apiDeleteList`/`apiDeleteItem` ignore `Response.ok`, so a 4xx/5xx resolves as success and the resource layer (`listData.ts` `deleteList`/`deleteListItem`) removes data from caches on a server failure. The resource layer already `try/catch`es these calls — it just never sees a rejection today. The fix is contained to the API layer. A dedicated `http.ts` module (rather than adding to `client.ts`) keeps `requestVoid` unit-testable and avoids a `client.ts`↔`auth.ts` import cycle — a refinement of the spec's "shared helper" note.

- [ ] **Step 1: Write the failing helper test**

Create `frontend/src/api/http.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestVoid } from './http'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('./client', () => ({ apiFetch }))

describe('requestVoid', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves on a 204 response', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'fail')).resolves.toBeUndefined()
  })

  it('rejects a typed ApiError on non-2xx, using the parsed detail', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ detail: 'Not allowed' }),
    })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'fail')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Not allowed',
    })
    expect(ApiError).toBeDefined()
  })

  it('falls back to the provided message when there is no detail', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error('no body')),
    })
    await expect(requestVoid('/x', { method: 'DELETE' }, 'Failed to delete')).rejects.toMatchObject({
      status: 500,
      message: 'Failed to delete',
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npm test -- src/api/http`
Expected: FAIL — `./http` does not exist.

- [ ] **Step 3: Create `http.ts`**

Create `frontend/src/api/http.ts`:

```ts
import { apiFetch } from './client'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function readError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new ApiError(data.detail ?? fallback, res.status)
}

export async function requestVoid(
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<void> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw await readError(res, fallback)
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd frontend && npm test -- src/api/http`
Expected: PASS.

- [ ] **Step 5: Move `ApiError`/`readError` out of `auth.ts`**

In `frontend/src/api/auth.ts`, delete the local `ApiError` class and `readError` function (lines 20-33) and change the top imports (lines 1) so `auth.ts` imports `readError` from `http` and re-exports `ApiError`:

```ts
import { apiFetch } from './client'
import { readError } from './http'

export { ApiError } from './http'
```

Leave every existing `throw await readError(res, '...')` call site in `auth.ts` unchanged — they now use the imported `readError`.

- [ ] **Step 6: Route the DELETE wrappers through `requestVoid` — write failing tests**

Create `frontend/src/api/lists.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDeleteItem, apiDeleteList } from './lists'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('./client', () => ({ apiFetch }))

describe('list delete wrappers surface server failures', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects apiDeleteList on a 500', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({}),
    })
    await expect(apiDeleteList('list-1')).rejects.toMatchObject({ name: 'ApiError', status: 500 })
  })

  it('resolves apiDeleteList on a 204', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 204 })
    await expect(apiDeleteList('list-1')).resolves.toBeUndefined()
  })

  it('rejects apiDeleteItem on a 403', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ detail: 'Not allowed' }),
    })
    await expect(apiDeleteItem('list-1', 'item-1')).rejects.toMatchObject({ status: 403 })
  })
})
```

Run: `cd frontend && npm test -- src/api/lists`
Expected: FAIL — the wrappers currently ignore `ok` and resolve.

- [ ] **Step 7: Implement the wrapper change**

In `frontend/src/api/lists.ts`, add to the imports (line 1 area):

```ts
import { requestVoid } from './http'
```

Replace `apiDeleteList` (lines 121-126):

```ts
export async function apiDeleteList(id: string, options?: ListMutationOptions): Promise<void> {
  await requestVoid(
    `/api/lists/${id}`,
    { method: 'DELETE', headers: buildListMutationHeaders(options) },
    'Failed to delete list',
  )
}
```

Replace `apiDeleteItem` (lines 157-166):

```ts
export async function apiDeleteItem(
  listId: string,
  itemId: string,
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/${listId}/items/${itemId}`,
    { method: 'DELETE', headers: buildListMutationHeaders(options) },
    'Failed to delete item',
  )
}
```

- [ ] **Step 8: Run tests + typecheck + lint**

Run: `cd frontend && npm test -- src/api && npm run lint`
Expected: PASS. Typecheck confirms every `ApiError` importer (e.g. `VerifyEmailPage`) still resolves via the re-export.

- [ ] **Step 9: Verify the real flow (verify skill)**

With the app running, trigger a DELETE the server rejects (e.g. delete a list you only have viewer access to, or stop the backend mid-action): the item must **not** disappear from the UI and a "Failed to delete…" toast must appear (the existing `listData.ts` catch now fires).

- [ ] **Step 10: Commit (confirm with user first)**

```bash
git add frontend/src/api/http.ts frontend/src/api/http.test.ts frontend/src/api/auth.ts frontend/src/api/lists.ts frontend/src/api/lists.test.ts
git commit -m "fix(lists): fail list/item deletes on non-2xx responses"
```

---

### Task 3: Reject empty PATCH bodies before auth/mutation (#5)

**Files:**
- Create: `backend/app/schemas/common.py`
- Modify: `backend/app/schemas/lists.py:42` (`ListItemUpdate` base)
- Modify: `backend/app/schemas/calendar.py:74` (`CalendarEventUpdate` base)
- Modify: `backend/app/schemas/dashboards.py:64` (`DashboardUpdate` base)
- Modify: `backend/app/routers/lists.py:387-388` (unconditional `assert_can_edit`)
- Test: `backend/tests/test_lists.py` (add empty-body + viewer cases)
- Test: `backend/tests/test_calendar.py` (add empty-body case)
- Test: `backend/tests/test_dashboards.py` (add empty-body case)

**Interfaces:**
- Produces: `PatchModel(BaseModel)` in `app.schemas.common` — a base that raises a validation error (→ HTTP 422) when `model_fields_set` is empty.
- Produces: `PATCH /api/lists/{id}/items/{item_id}`, `PATCH /api/calendar/events/{event_id}`, `PATCH /api/dashboards/{id}` all return **422** on `{}`; the list-item endpoint asserts `can_edit` on any (now non-empty) body.

**Context:** List-item PATCH only checks permission `if body.model_fields_set:` (lists.py:387), so a viewer can write `updated_by`/history with `{}`. Calendar already asserts `can_edit` unconditionally (calendar.py:248); dashboard asserts per-field. Rejecting `{}` at the schema layer runs before the handler (before auth/mutation) and removes the false-history path for all three uniformly.

- [ ] **Step 1: REGRESSION CHECK — confirm nothing sends an empty PATCH**

Run:

```bash
cd /home/wsl-nathan/Development/frontdashboard
rg -n "apiUpdateItem|apiUpdateList|apiUpdateEvent|apiUpdateDashboard|method: 'PATCH'|\.patch\(" frontend/src backend/tests
```

Confirm every caller of the three target endpoints always sends at least one field (known callers `apiUpdateList`/`apiUpdateItem` do). **If any legitimate caller can send `{}`, STOP and ask the user before continuing** — rejecting it would be a behavior regression.

- [ ] **Step 2: Write failing backend tests**

In `backend/tests/test_lists.py`, add (this file already defines local `_make_dashboard`, `_make_list`, `_register_client`, `_csrf`, and imports `create_list_item` patterns — mirror the existing `test_shared_dashboard_viewer_cannot_mutate` at lines 101-124):

```python
async def test_empty_item_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"])

    _csrf(auth_client)
    resp = await auth_client.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={})
    assert resp.status_code == 422


async def test_viewer_empty_item_patch_is_rejected_not_written(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    lst = await _make_list(auth_client, dashboard["id"])
    item = await create_list_item(auth_client, lst["id"])

    other = await _register_client("viewer-empty@example.com")
    try:
        me = await other.get("/api/auth/me")
        _csrf(auth_client)
        await auth_client.post(
            f"/api/dashboards/{dashboard['id']}/shares",
            json={"principal_type": "user", "principal_id": me.json()["id"], "role": "viewer"},
        )
        _csrf(other)
        empty = await other.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={})
        assert empty.status_code == 422

        real = await other.patch(f"/api/lists/{lst['id']}/items/{item['id']}", json={"checked": True})
        assert real.status_code == 403
    finally:
        await other.__aexit__(None, None, None)
```

Ensure `create_list_item` is imported in `test_lists.py` (from `tests.helpers`); add the import if missing.

In `backend/tests/test_calendar.py`, add (mirror that file's existing dashboard/event setup helpers):

```python
async def test_empty_event_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)
    event = await _make_event(auth_client, dashboard["id"])

    _csrf(auth_client)
    resp = await auth_client.patch(f"/api/calendar/events/{event['id']}", json={})
    assert resp.status_code == 422
```

In `backend/tests/test_dashboards.py`, add:

```python
async def test_empty_dashboard_patch_is_rejected(auth_client: AsyncClient) -> None:
    dashboard = await _make_dashboard(auth_client)

    _csrf(auth_client)
    resp = await auth_client.patch(f"/api/dashboards/{dashboard['id']}", json={})
    assert resp.status_code == 422
```

(Use each test file's own local helper names for creating a dashboard/event — `_make_dashboard`/`_make_event` if present, otherwise the `tests.helpers` `create_dashboard`/`create_calendar_event` functions and `set_csrf`.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_lists.py -k empty -v tests/test_calendar.py -k empty tests/test_dashboards.py -k empty`
Expected: FAIL — empty bodies currently return 200 (and the viewer empty PATCH returns 200, silently writing audit state).

- [ ] **Step 4: Add the `PatchModel` base**

Create `backend/app/schemas/common.py`:

```python
from typing import Self

from pydantic import BaseModel, model_validator


class PatchModel(BaseModel):
    """Base for PATCH bodies: reject an empty patch (no fields set) with a 422."""

    @model_validator(mode="after")
    def _reject_empty_patch(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self
```

- [ ] **Step 5: Apply the base to the three Update schemas**

`backend/app/schemas/lists.py` — add `from app.schemas.common import PatchModel` to the imports and change line 42:

```python
class ListItemUpdate(PatchModel):
```

`backend/app/schemas/calendar.py` — add `from app.schemas.common import PatchModel` and change line 74:

```python
class CalendarEventUpdate(PatchModel):
```

`backend/app/schemas/dashboards.py` — add `from app.schemas.common import PatchModel` and change line 64 (keep its `model_config = ConfigDict(extra="forbid")` line inside the class unchanged):

```python
class DashboardUpdate(PatchModel):
```

- [ ] **Step 6: Make the list-item permission check unconditional**

In `backend/app/routers/lists.py`, replace lines 387-388:

```python
    if body.model_fields_set:
        permissions.assert_can_edit(role)
```

with:

```python
    permissions.assert_can_edit(role)
```

(The following `for field in body.model_fields_set:` loop is unchanged; the empty-body case can no longer reach here.)

- [ ] **Step 7: Run the target tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_lists.py tests/test_calendar.py tests/test_dashboards.py -v`
Expected: PASS, including the new empty-body/viewer tests and all pre-existing tests (e.g. `test_shared_dashboard_viewer_cannot_mutate`).

- [ ] **Step 8: Full backend lint + tests**

Run: `cd backend && uv run ruff check . && uv run pytest -q`
Expected: PASS.

- [ ] **Step 9: Verify the real flow (verify skill)**

With the app running, send `PATCH {}` (via curl/HTTP client with CSRF) to a list item, a calendar event, and a dashboard — each returns 422, and no activity/history entry is created. A normal single-field PATCH still succeeds.

- [ ] **Step 10: Commit (confirm with user first)**

```bash
git add backend/app/schemas/common.py backend/app/schemas/lists.py backend/app/schemas/calendar.py backend/app/schemas/dashboards.py backend/app/routers/lists.py backend/tests/test_lists.py backend/tests/test_calendar.py backend/tests/test_dashboards.py
git commit -m "fix(api): reject empty PATCH bodies and assert list-item edit permission"
```

---

## Self-Review

**Spec coverage:**
- #3 (verification replay) → Task 1 (backend 409 branch + test + frontend message). ✓
- #4 (DELETE status) → Task 2 (`requestVoid` + wrapper routing + tests). ✓
- #5 (empty PATCH) → Task 3 (`PatchModel` on three schemas + unconditional list-item authz + tests). ✓
- Spec's concurrency test for #3 explicitly deferred to the #6 phase (documented in Task 1 Context) — the row lock already exists. ✓
- Spec's regression-watches (empty-PATCH callers, `ApiError` importers) are explicit steps (Task 3 Step 1; Task 2 Step 8). ✓

**Placeholder scan:** No TBD/TODO; every code step contains the actual code and exact commands. ✓

**Type consistency:** `requestVoid(path, init, fallback)` defined in Task 2 Step 3 and used identically in Task 2 Step 7. `ApiError` produced in `http.ts` (Task 2 Step 3), re-exported from `auth.ts` (Task 2 Step 5), consumed by `VerifyEmailPage` (Task 1) — consistent. `PatchModel` defined once (Task 3 Step 4), applied by name in Task 3 Step 5. `getVerificationErrorMessage` exported (Task 1 Step 7) and imported in its test (Task 1 Step 5). ✓

**Deviation from spec noted:** shared HTTP helper lives in a new `http.ts` (not `client.ts`) for testability and to avoid an import cycle — recorded in Task 2 Context.
