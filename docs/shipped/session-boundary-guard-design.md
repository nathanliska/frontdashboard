# Design — Extend the session-boundary guard to the auth + notifications stores (#46, #47, #48)

**Date:** 2026-07-17
**Status:** ✅ Shipped 2026-07-18 (`fa00095`, `6ec0263`, `492f160`, tests `ae5cdb9`).
**Findings:** #46 (auth store's `set({user})` unguarded post-await), #47 (notifications store's
post-await writes unguarded — its twin), #48 (`logout()` clears store state before tearing down the
session/SSE). All three surfaced/confirmed by the 2026-07-17 Phase 2 security review and share one
remediation: the session-generation guard the dashboard store already uses.

**Not in this doc.** #15 (prod rate-limit bucket) and register enumeration are separate decisions;
#49–#52 are the deferred low batch.

## Theme

The dashboard store enforces the invariant **"no async write survives a session boundary"** by
construction: a module-level `sessionGeneration` counter, bumped at every boundary, is captured at
the entry of each async action and re-checked before every post-`await` write (`sessionGuard()`).
The auth store and the notifications store have no such guard, so in a shared browser tab a prior
account's in-flight response can land after the next account logs in and overwrite live state:

- **#46 (High):** `auth.ts` `updateProfile`/`updatePreferences` do `set({ user: updated })` after an
  `await` with no generation check. Account A's profile/preferences response resolving after B logs
  in overwrites B's `user` (email, display name, preferences, **and `user.id`**). Corrupting
  `user.id` also breaks B's SSE echo suppression (which keys off `user.id`).
- **#47 (High):** the notifications store's `load`/`loadUnreadCount`/`markRead`/`markAllRead` write
  post-`await` with no guard; `reset()` only nulls the module promise handles and clears state, which
  does not stop an already-in-flight `apiGetNotifications()` whose `.then` still calls `set(...)`. A's
  notification list — message bodies, actor names, entity ids — lands in B's session. Highest-PII
  leak of the set.
- **#48 (Medium / defense-in-depth):** `logout()` runs `resetSessionData()` and then
  `await apiLogout()` while `user`/`status` stay authenticated and the SSE stream stays open, so a
  read *issued after* the reset (e.g. an SSE event → `loadSummaries`) runs under A's still-live cookie
  and repopulates a just-cleared store.

## What is actually true today (verified in code)

- **Dashboard store (the template).** `frontend/src/stores/dashboard.ts`: a module-level
  `let sessionGeneration = 0` (line ~81), bumped by `resetDashboardData()` (`sessionGeneration += 1`,
  line ~778). Inside the store factory, `sessionGuard()` (lines ~312-320) captures
  `const gen = sessionGeneration` and returns `{ isCurrent: () => gen === sessionGeneration, set: (…) => { if (gen === sessionGeneration) set(…) } }`.
  Every post-`await` write in the store routes through `guard.set` / `guard.isCurrent()`.
- **`resetDashboardData()` and `useNotificationsStore.reset()` are called only from
  `resetSessionData()`** (`auth.ts:25-31`) in production — which runs at every boundary: init-unauth
  (`auth.ts:70`), login (`:81`), verifyEmail (`:93`), logout (`:98`). Dashboard tests
  (`dashboard.test.ts`) also call `resetDashboardData()` directly and rely on it bumping the counter.
- **Auth store (`auth.ts`).** `updatePreferences` (`set({ user: updated })` after
  `await apiUpdatePreferences`, line ~106) and `updateProfile` (`set({ user: updated })` after
  `await apiUpdateProfile`, line ~115). No generation gate. `logout()` (lines ~97-101) resets first,
  awaits `apiLogout()`, then sets unauthenticated.
- **Notifications store (`notifications.ts`).** `load` (`set({ notifications, unreadCount, loaded })`,
  line ~40), `loadUnreadCount` (line ~57), `markRead` (line ~71), `markAllRead` (line ~84) all write
  after an `await`; `addFromSse` (line ~101) is synchronous. `reset()` (lines ~107-116) nulls
  `notificationsPromise`/`unreadCountPromise` and clears state. Single-flight promise guards exist but
  do not stop a stale *completion*.
- **`toggleFavorite` (`dashboard.ts:433-435`) already models the correct cross-store write:** it gates
  its `useAuthStore.setState({ user })` on `guard.isCurrent()`.

## Design

### 1. One shared generation primitive — `frontend/src/stores/sessionGeneration.ts` (new)

```ts
// Monotonic counter bumped at every auth boundary. Async store writes capture it at entry and
// no-op if it has moved, so a request begun under one session can't write into the next.
let generation = 0

export function bumpSessionGeneration(): void {
  generation += 1
}

export function currentSessionGeneration(): number {
  return generation
}
```

All three stores read this single counter. Correctness only requires the counter to advance at least
once per boundary; it is bumped by each store's reset (see below), which `resetSessionData()` always
invokes — so any capture taken before a boundary is stale afterward.

### 2. Dashboard store migrates to the shared counter — `stores/dashboard.ts`

Mechanical, behavior-preserving:
- Remove the private `let sessionGeneration = 0`; import `bumpSessionGeneration` +
  `currentSessionGeneration`.
- `resetDashboardData()` calls `bumpSessionGeneration()` in place of `sessionGeneration += 1` (it
  still bumps, so every existing `dashboard.test.ts` call site passes unchanged).
- `sessionGuard()` captures `const gen = currentSessionGeneration()` and compares against
  `currentSessionGeneration()` in both `isCurrent` and `set`.

No call-site or test changes in the dashboard store — only the counter's home moves. Its existing
cross-session-drop tests remain the regression net.

### 3. Notifications store (#47) — `stores/notifications.ts`

- `reset()` calls `bumpSessionGeneration()` (in addition to nulling promise handles + clearing state).
- Add a local `sessionGuard()` helper inside the store factory, identical in shape to the dashboard
  store's (capture `currentSessionGeneration()`, expose a guarded `set`). Route the post-`await`
  writes in `load`, `loadUnreadCount`, `markRead`, `markAllRead` through it.
- `addFromSse` stays a plain `set` — it is synchronous (no `await` to straddle) and the SSE stream is
  torn down at logout. `setPanelOpen` stays a plain `set` (synchronous UI state).

### 4. Auth store (#46) — `stores/auth.ts`

- In `updateProfile` and `updatePreferences`, capture `const gen = currentSessionGeneration()` before
  the `await`, and only `set({ user: updated })` if `gen === currentSessionGeneration()` after it
  (otherwise drop — a boundary crossed mid-request). The `toast.error` on failure is unchanged.
- `resetSessionData()` already bumps the generation at every boundary (it calls `resetDashboardData()`
  and `useNotificationsStore.reset()`, both of which now bump the shared counter), so the auth store's
  guard fires without an auth-specific counter.

### 5. Logout ordering (#48) — `stores/auth.ts`

Reorder `logout()` so the session view is torn down before the network round-trip:

```ts
async logout() {
  set({ status: 'unauthenticated', user: null })  // closes the SSE stream via useSSE cleanup
  resetSessionData()                               // clears stores + bumps the generation
  await apiLogout().catch(() => {})
}
```

The cookie remains in the browser until the server clears it, so `apiLogout()` still authenticates;
but the EventSource is closed and the stores cleared/bumped before the await, so no read is issued
under A's still-live cookie during logout.

## Data flow

```
boundary (init-unauth | login | verifyEmail | logout)
  └─ resetSessionData()
       ├─ useNotificationsStore.reset()  → bumpSessionGeneration()
       ├─ resetAgendaData / resetCalendarData / resetListData   (resource caches, already safe)
       └─ resetDashboardData()           → bumpSessionGeneration()
   ⇒ any auth/notifications/dashboard async write captured before this point no-ops on its guard check
```

## Testing (Vitest; `stores/*.test.ts`)

- **Auth store cross-session drop (#46):** begin `updateProfile` (and `updatePreferences`) whose
  `apiUpdateProfile` is still pending → bump the generation via `bumpSessionGeneration()` (simulate a
  boundary) → resolve the pending call → assert `useAuthStore.getState().user` was **not** overwritten.
  Prove it fails without the guard.
- **Notifications cross-session drop (#47):** begin `load()` (and `markRead`) whose fetch is pending →
  bump the generation → resolve → assert the store was not written (no A notifications leak). Prove it
  fails without the guard.
- **Logout ordering (#48):** stub `apiLogout` with a deferred promise; call `logout()`; assert
  `status === 'unauthenticated'` / `user === null` **before** the `apiLogout` promise resolves.
- **Boundary wiring stays green:** the existing `auth.test.ts` boundary assertions and the dashboard
  store's cross-session tests must still pass (the shared-counter migration is behavior-preserving).

## Out of scope / deferred

- **#15** (prod rate-limit global bucket, High) and **register enumeration** — separate decisions.
- **#49–#52** — the deferred low batch (reaper `last_used_at`, `ENVIRONMENT` fail-open, register
  Unicode 500, SSE resync griefing).
- The resource caches (`agendaData`/`calendarData`/`listData` via `scopedQuery`) already handle the
  boundary safely (reset detaches the entry an in-flight fetch references) and are unchanged.

## Doc/tracker updates on ship

Close #46, #47, #48 (→ ✅ Shipped) with SHAs; update the security-review row + changelog in
`review-findings.md`; fold the "auth + notifications stores are session-generation–guarded" behavior
into `CONTEXT.md`; move this design + its plan to `docs/shipped/`.

## Execution

Subagent-driven (per superpowers:subagent-driven-development).
