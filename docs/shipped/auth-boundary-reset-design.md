# Design — Reset dashboard state at the authentication boundary

**Date:** 2026-07-17
**Status:** ✅ Shipped 2026-07-17 (`2c873bc`, `26a6e59`, `2c7e5ec`, `8c813f3`). Phase 2 spec 2 of 4.
**Findings:** #1 (reset dashboard state at the authentication boundary), incorporating the
2026-07-16 validation-pass correction (module-level machinery in `stores/dashboard.ts:64-71`, not
just store fields, must reset).

**Not in this doc.** The other Phase 2 specs are independent: #13 (Argon2 off the event loop),
#31 (email normalization + config validation). Spec 1 (session revocation) shipped 2026-07-17.

## Theme

Every store that holds account data is reset when the user crosses an authentication boundary —
except the dashboard store. Logout and unauthenticated-init clear notifications and the
agenda/calendar/list resource caches, but leave the dashboard store's fields, its module-level
request machinery, and the pending-mutation map holding the previous account's data. That is a
privacy-boundary failure: account B, in the same tab, can see account A's dashboards.

## What is actually true today (verified in code)

- **`resetSessionData()` exists but omits dashboards.** It is defined *inside* `init`'s closure
  (`stores/auth.ts:47-52`) and calls `resetNotifications` + `resetAgendaData` + `resetCalendarData`
  + `resetListData`. `logout` (`auth.ts:93-100`) repeats the same four resets inline. Neither
  touches the dashboard store.
- **The dashboard store has no reset.** State lives in three places, none cleared at a boundary:
  1. **Store fields** (`stores/dashboard.ts:301-308`): `summaries`, `summariesLoaded`,
     `summariesLoading`, `dashboard`, `loading`, `loadError`, `conflict`.
  2. **Module-level machinery** (`dashboard.ts:64-71`): `inFlightDashboardLoad`,
     `inFlightSummariesLoad`, `queuedSummariesForceReload`, `latestDashboardRequest`,
     `scheduledSummariesRefreshTimer` + its `…Promise`/`resolve…`/`reject…` handles.
  3. **Pending-mutation map** (`utils/dashboard/dashboardMutation.ts:3`):
     `pendingDashboardMutationIds` (SSE echo-suppression bookkeeping).
- **`login()` and `verifyEmail()` reset nothing** (`auth.ts:77-91`). Reset happens only on logout
  and unauthenticated-init, so a new user installed without a preceding logout inherits stale state.
- **The concrete exploit.** A logs out → dashboard state survives, `summariesLoaded` stays `true`
  → B logs in (no reset) → B opens `/dashboards` → `loadSummaries()` early-returns on the stale
  `summariesLoaded` flag (`dashboard.ts:313-314`) → **B sees A's dashboard cards.**
- **The async-response race.** A request begun under account A can resolve *after* the boundary and
  write A's data into the store. The store already guards *within* a session with request serials
  (`latestRequestSerial`, `latestDashboardRequest`); it has no guard *across* sessions.

## Design

Three parts: a dashboard reset, a session-generation guard that all async writes route through, and
unified wiring at every boundary.

### 1. `resetDashboardData()` — a standalone export in `stores/dashboard.ts`

Mirrors the existing `resetListData()` / `resetCalendarData()` convention (a plain exported function,
not a store action, because it must also clear the module-level machinery that lives outside the
store). It:

- Resets store fields to their initial values via `useDashboardStore.setState({...})`:
  `summaries: []`, `summariesLoaded: false`, `summariesLoading: false`, `dashboard: null`,
  `loading: false`, `loadError: false`, `conflict: false`.
- Clears the module-level machinery: null `inFlightDashboardLoad`, `inFlightSummariesLoad`,
  `latestDashboardRequest`; set `queuedSummariesForceReload = false`; `clearTimeout` the
  `scheduledSummariesRefreshTimer` and null the timer + its promise/resolve/reject handles (the
  pending debounce promise is abandoned, not resolved — nothing is awaiting it across a boundary).
- Calls `resetPendingDashboardMutations()` (new, below).
- Increments the session generation (below).

### 2. Session generation — a guarded-set choke point

A module-level `let sessionGeneration = 0` in `stores/dashboard.ts`, incremented by
`resetDashboardData()`. The invariant — **no async write survives a session boundary** — is enforced
by construction, not per-call-site: every async store action captures the generation once at entry
and routes all of its post-await writes through a session-scoped setter.

```ts
// inside create<DashboardState>()((set, get) => { … })
function sessionScopedSet(): typeof set {
  const gen = sessionGeneration
  return ((partial) => {
    if (gen === sessionGeneration) set(partial as never)
  }) as typeof set
}
```

Each async action does `const gset = sessionScopedSet()` at entry, then uses `gset(...)` for every
write that follows an `await` — including the success write **and** the `finally` block's
`summariesLoading: false` (the important subtlety: a stale load's `finally` must not flip loading
state into the new session). Purely synchronous pre-await writes (e.g. `set({ summariesLoading: true })`
at the top of `loadSummaries`, or a mutation's optimistic update) keep using plain `set` — they run
in the current session by definition, and any effect they leave behind is wiped by the reset that
bumped the generation.

This uniformly covers loads and mutations, including optimistic-then-confirm mutations
(`toggleFavorite`): the sync optimistic write is erased by reset; the async confirm-or-rollback is
dropped by the stale generation.

**Actions routed through `gset` (every post-await write):** `loadSummaries`, `loadDashboard`,
`createDashboard`, `renameDashboard`, `archiveDashboard`, `deleteDashboard`, `toggleFavorite`,
`saveLayout`, `addWidget`, `removeWidget`, `updateWidget`. **SSE handlers:** `handleContentEvent`
is synchronous (no straddle possible); `handleDashboardEvent` is `async`. Both patch caches from the
live connection, which is torn down at logout — but the plan must inspect `handleDashboardEvent`'s
write path: where it delegates to the guarded load actions it is covered transitively; any *direct*
post-await `set` it performs should also route through `gset`, so the by-construction invariant holds
for it too.

### 3. `resetPendingDashboardMutations()` — in `utils/dashboard/dashboardMutation.ts`

A production reset that clears the `pendingDashboardMutationIds` map. The existing
`__resetPendingDashboardMutationsForTests()` becomes a thin alias so tests and production share one
implementation.

### 4. Unified `resetSessionData()` wired at every boundary — `stores/auth.ts`

Hoist the reset helper out of `init`'s closure into one shared function that calls all five resets:
`resetNotifications` + `resetAgendaData` + `resetCalendarData` + `resetListData` +
**`resetDashboardData`**. Call it at all four boundaries:

- **unauthenticated-init** (`init`, unauth path) — as today, now including dashboards.
- **logout** — replace the four inline resets with the shared helper.
- **login** — call it *after* `apiLogin` succeeds, *before* `set({ status: 'authenticated', user })`,
  so a failed login never wipes current state.
- **verifyEmail** — same placement as login.

**Import note.** `auth.ts` will import `resetDashboardData` from `dashboard.ts`, which already imports
`useAuthStore` from `auth.ts` — a runtime-only cross-store cycle. Both bindings are used only inside
functions (never at module-eval time), so the cycle is safe; `frontend/CLAUDE.md` already sanctions
cross-store reads/writes as normal here.

## Data flow

```
boundary (init-unauth | logout | login | verifyEmail)
  └─ resetSessionData()
       ├─ resetNotifications() / resetAgendaData() / resetCalendarData() / resetListData()
       └─ resetDashboardData()
            ├─ useDashboardStore.setState(initial fields)
            ├─ clear module machinery (timers, in-flight promises, serials)
            ├─ resetPendingDashboardMutations()
            └─ sessionGeneration++        ← any prior-session async write now no-ops via gset
```

## Testing

`stores/dashboard.test.ts` (node env, matching the file today):

- **Account-switch regression (the exploit):** populate summaries (so `summariesLoaded === true`) →
  `resetSessionData()` → assert store fields and module machinery are cleared, then assert a
  subsequent `loadSummaries()` actually issues a fetch (does not early-return on a stale
  `summariesLoaded`).
- **Cross-session write drop (the race):** begin a `loadSummaries` whose fetch is still pending →
  call `resetDashboardData()` (bump generation) → resolve the pending fetch → assert nothing was
  written to the store (the guarded setter dropped it). Prove it fails without the guard.
- **Mutation write drop:** begin a mutation (e.g. `renameDashboard`) whose request is pending →
  reset → resolve → assert no write landed. Covers the choke-point's mutation coverage.
- **Pending-mutation map cleared:** record a pending mutation id → `resetDashboardData()` → assert
  the map no longer suppresses that id's echo.

`stores/auth.test.ts`:

- Assert each of the four boundaries (init-unauth, logout, login, verifyEmail) invokes the dashboard
  reset (spy on `resetDashboardData`), so the wiring can't silently regress.

## Out of scope / deferred

- **AbortController request cancellation.** The best-practice ceiling is per-request cancellation via
  `AbortSignal`, but that means threading a signal through `apiFetch` and every dashboard API call and
  teaching error handling to distinguish `AbortError` from real failures. That is the TanStack Query
  migration (finding #23, deferred). Within the hand-rolled store, the generation guard is the right
  fit and closes the same race.
- **Other stores.** `ui`/`confirm`/`toast` hold UI state, not account data, and are correctly left
  untouched. The resource caches already reset; this spec only adds the missing dashboard piece.
