# Design — Security quick wins (Phase 1)

**Date:** 2026-07-11
**Source:** `docs/references/review-findings.md` findings #3, #4, #5
**Phase:** 1 of the security-first rollout of the review backlog
**Status:** Approved for planning

## Theme

Make silent failures actually fail, and close two narrow auth/authz gaps. All three
findings are Small/Low effort. No new dependencies. One deliberate user-visible behavior
change (verification-link auto-login), called out below.

Grounding note: reading the code showed the fixes are narrower than the findings implied.
This spec reflects the code as it actually is, not the finding summaries.

---

## Finding #3 — Stop replaying consumed verification links into new sessions

### Current behavior (verified in code)
`backend/app/routers/auth.py:243-280` (`verify_email`):
- Already selects the token `WITH FOR UPDATE` (row lock present, line 259).
- Already detects a replay: `token.used_at is not None` with a matching
  `user.email_verified_at` (lines 270-272).
- **The leak:** on that replay branch it still falls through to
  `_create_session(user, response, db)` (line 277), minting fresh cookies + a refresh
  token. A consumed verification URL is therefore a reusable passwordless login until the
  token's `expires_at`.

The current test `backend/tests/test_auth.py:91-108` asserts this replay-creates-a-session
behavior, so it must be replaced.

### Target behavior
- **First use:** unchanged — consume the token (`used_at`/`email_verified_at` set) and
  create the authenticated session. 200 + `UserResponse`, cookies set.
- **Replay (token already used, same user):** do **not** call `_create_session`; set no
  cookies and no refresh token. Respond `409 Conflict` with
  `detail="Email already verified. Please sign in."`.
- **Invalid / expired / unknown token:** unchanged — `400` "Invalid or expired
  verification link".
- **Concurrency:** two simultaneous first-time verifications of the same token — the row
  lock serializes them; the loser reads `used_at is not None` and takes the 409 replay
  branch. No second session is created.

### Why 409 (not 400)
An already-verified user should be routed to **login**, not told to "request a new link"
(the 400 message). A distinct status lets the frontend redirect cleanly. The token is a
high-entropy secret, so returning "already verified" only to a holder of the consumed token
is not a meaningful enumeration signal.

### Frontend contract change
- `frontend/src/api/auth.ts` `apiVerifyEmail` already throws `ApiError(status)` on non-ok — no change needed there.
- `frontend/src/pages/VerifyEmailPage.tsx`:
  - `getVerificationErrorMessage` currently special-cases only `400`. Add a `409` branch.
  - On `409`, instead of showing an error in place, navigate to the login route with a
    short "Your email is already verified — please sign in." message.
  - The `400` path is unchanged (invalid/expired → resend UI).

### ⚠️ Deliberate behavior change (regression-watch)
Today, clicking an **already-consumed** verification link silently logs the user in.
After this change it will send them to the login screen instead. This is the point of the
fix and was approved, but it is a real UX change and is listed here so it is reviewed, not
discovered.

### Tests (replace the existing replay test)
- Replay returns 409, sets **no** `Set-Cookie` header, issues no refresh token.
- First-time verification still returns 200 with cookies.
- Concurrent first-time verification (two DB sessions, same token) yields exactly one
  session; the second returns 409.

---

## Finding #4 — Treat failed list and item DELETEs as failures

### Current behavior (verified in code)
`frontend/src/api/lists.ts`:
- `apiDeleteList` (121-126) and `apiDeleteItem` (157-166) call `apiFetch(... DELETE ...)`
  and **ignore `Response.ok`** — a 403/404/500 resolves as success.
- The resource layer already guards correctly *if the wrapper throws*:
  `frontend/src/resources/listData.ts` `deleteList` (230-240) and `deleteListItem`
  (283-300) wrap the call in `try/catch`, only mutating caches on success and toasting on
  error. Because the wrapper never throws, the catch is currently dead and caches are
  corrupted on server failure (false-success disappearance).

Note `apiRemoveListShare` (196-199) already checks `res.ok` — the inconsistency is real.

### Target behavior
- Add a shared `requestVoid(path, init, fallback)` helper (and the `ApiError` it throws) in
  `frontend/src/api/client.ts`. It calls `apiFetch`, treats any non-2xx (including the
  normal 204) correctly, and **rejects with a typed `ApiError`** on non-2xx, parsing
  `{ detail }` when present.
- Route `apiDeleteList` and `apiDeleteItem` through `requestVoid`.
- No change needed in `listData.ts` — its existing catch blocks now do the right thing.

### `ApiError` relocation (low-churn)
`ApiError` + `readError` currently live in `frontend/src/api/auth.ts`, but `client.ts`
cannot import from `auth.ts` (auth.ts already imports `apiFetch` from client.ts — that
would be circular). Move `ApiError` + `readError` into `client.ts` and **re-export** them
from `auth.ts` (`export { ApiError } from './client'`) so existing import sites
(e.g. `VerifyEmailPage`) keep working unchanged.

Regression-watch: after the move, confirm every `ApiError` import site still resolves
(typecheck + build).

### Tests
- `apiDeleteList` / `apiDeleteItem` reject on 403, 404, 500 (typed `ApiError`, correct status).
- `deleteList` / `deleteListItem` do **not** mutate caches when the DELETE fails, and do
  toast the error.
- A 204 success still resolves and mutates caches.

---

## Finding #5 — Reject empty PATCH bodies before authorization and mutation

### Current behavior (verified in code)
- **List item PATCH** `backend/app/routers/lists.py:375-406`: permission is checked only
  `if body.model_fields_set:` (line 387). An empty `{}` skips the check but still sets
  `updated_by`, commits, logs a `list_item_updated` event, and broadcasts — **a viewer can
  write audit state.** This is the real authorization gap.
- **Calendar event PATCH** `backend/app/routers/calendar.py:246-285`: already asserts
  `can_edit` unconditionally (line 248). Its only defect is that an empty body still sets
  `updated_by`, logs activity, commits, and broadcasts — false history, no authz hole.
- **Dashboard PATCH** `backend/app/routers/dashboards.py:521-544`: asserts per field
  (`name`→`can_edit`, `archived`→`can_delete`). An empty body skips both but still builds
  an event, commits, and broadcasts — false history.

### Target behavior
1. **Reject empty patch bodies with 422 at the schema layer**, before the handler runs
   (i.e. "before authorization and mutation"). Add a reusable `@model_validator(mode="after")`
   that raises when `model_fields_set` is empty, applied to `ListItemUpdate`,
   `CalendarEventUpdate`, and `DashboardUpdate`. This yields a uniform 422 with a clear
   message and needs no per-handler edits for the empty-body case.
2. **Close the list-item authz hole:** move `permissions.assert_can_edit(role)` in
   `update_item` out of the `if body.model_fields_set:` guard so it runs unconditionally
   on any (now guaranteed non-empty) body.
3. Calendar and dashboard handlers need no authz change — the empty-body validator removes
   their false-history path.

### ⚠️ Regression-watch (must verify during implementation)
Rejecting `{}` at the schema layer breaks any caller that legitimately sends an empty
PATCH. Before implementing, grep the frontend + backend for callers of these three PATCH
endpoints and confirm none intentionally send `{}` (the known callers — `apiUpdateList`,
`apiUpdateItem`, dashboard/calendar editors — always send at least one field). **If a
legitimate empty-PATCH caller exists, stop and ask before proceeding** — that would be a
behavior regression.

### Tests
- `{}` PATCH to list item, calendar event, and dashboard each returns 422 with no commit,
  no logged activity, no broadcast.
- A viewer (`can_edit` = false) sending `{}` to the list item endpoint gets 422 (not a
  silent audit write); a viewer sending a real field still gets 403.
- An editor sending a real single-field patch still succeeds (regression guard).

---

## Out of scope for Phase 1
- The calendar *occurrence* PATCH (`update_occurrence`, calendar.py:288+) and other
  mutation endpoints — only the three PATCH sites named in finding #5 are in scope.
- Refresh/reset token single-use hardening (#6), session reset (#1), SSE expiry (#8) — later
  phases.

## Testing / CI notes
- Backend tests require a Docker socket (Testcontainers). I will write the tests; running
  them locally requires Docker up (`make dev-up`).
- Run `make lint` and `make test` before proposing the work as done.

## Verification before "done"
Per the verify skill, drive the actual flows, not just unit tests:
- Register → verify link once (logs in) → click the same link again (lands on login with
  the already-verified message).
- Attempt a list/item delete that the server rejects (e.g. revoke access) and confirm the
  item does **not** vanish from the UI and an error toast shows.
- Send `{}` PATCH via API to each endpoint and confirm 422 + no history entry.

---

## Cross-cutting product decisions (recorded 2026-07-11)

These were decided during brainstorming and govern **later** phases, not Phase 1. Recorded
here and in agent memory so future specs don't re-litigate them.

| # | Decision | Affects findings |
|---|----------|------------------|
| Sequencing | Security-first phases, one theme/spec at a time | all |
| #40 | Full recoverable **"Move to trash"** lifecycle (trash view, restore, retention purge) for lists + dashboards, unified | #2, #38, #40 |
| #38/#40 | **30-day** trash retention; ~90-day notification/activity retention; prompt expired-token pruning | #38, #40 |
| #28 | Share discovery = **exact-email invite only** (no substring browse); active+verified targets, rate-limited | #19, #28 |
| #7 | Password change **logs out everywhere but the current session**; add a per-user token version checked on access | #7, #8 |
| #18 | **Keep per-resource sharing capability** — do NOT remove the polymorphic share table; only fix its validation/race bugs | #18, #19, #25, #39 |
| #8 | SSE stream ends at token expiry with **silent client auto-reconnect** (refresh + reopen) | #8 |
| #27 | Adopt **Radix UI** for Dialog/Popover primitives | #27 |
