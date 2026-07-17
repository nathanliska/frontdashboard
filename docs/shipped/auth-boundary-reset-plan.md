# Reset dashboard state at the authentication boundary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear all dashboard state — store fields, module-level request machinery, and the pending-mutation map — at every authentication boundary, and drop any async write from a prior session, so a second account in the same tab can never see the first account's dashboards.

**Architecture:** A new `resetDashboardData()` clears the dashboard store's three state layers and bumps a module-level `sessionGeneration`. Every async store action captures the generation at entry (via a `sessionGuard()` helper) and routes its post-await writes through a guarded setter that no-ops if the generation has moved. A unified `resetSessionData()` in the auth store calls all five per-domain resets at all four boundaries (init-unauth, logout, login, verifyEmail).

**Tech Stack:** React 19, TypeScript, Zustand, Vitest (node env by default), Biome.

## Global Constraints

- Vitest default env is **node**; these are store-logic tests, so no `// @vitest-environment jsdom` line is needed.
- Tests mock `api/*` modules with `vi.hoisted` + `vi.mock` and mock `stores/toast`; never hit real network. (`frontend/CLAUDE.md`)
- Cross-store reads/writes are normal here; the `auth ↔ dashboard` import cycle is runtime-only and safe. (`frontend/CLAUDE.md`)
- `npx tsc --noEmit` and `npm run lint` (Biome) must pass; `npm run format` fixes Biome formatting.
- Run frontend tests from `frontend/`: `npx vitest run <path>`.

---

## File Structure

- **Modify** `frontend/src/utils/dashboard/dashboardMutation.ts` — add `resetPendingDashboardMutations()`; make `__resetPendingDashboardMutationsForTests` a thin alias.
- **Modify** `frontend/src/stores/dashboard.ts` — add `sessionGeneration` + `sessionGuard()` (inside the store factory) + exported `resetDashboardData()`; route every async action's post-await writes through the guard.
- **Modify** `frontend/src/stores/auth.ts` — hoist `resetSessionData()` to a shared function including the dashboard reset; call it at all four boundaries.
- **Test** `frontend/src/stores/dashboard.test.ts` — reset + cross-session write-drop tests.
- **Test** `frontend/src/stores/auth.test.ts` — boundary-wiring + account-switch regression tests.

---

## Task 1: Dashboard reset primitives + guard the load paths

**Files:**
- Modify: `frontend/src/utils/dashboard/dashboardMutation.ts`
- Modify: `frontend/src/stores/dashboard.ts:64-71` (module vars), `:301-347` (loadSummaries), `:442-535` (loadDashboard)
- Test: `frontend/src/stores/dashboard.test.ts`

**Interfaces:**
- Produces: `resetDashboardData(): void` (exported from `stores/dashboard.ts`), `resetPendingDashboardMutations(): void` (exported from `utils/dashboard/dashboardMutation.ts`), and a module-local `sessionGuard()` returning `{ isCurrent(): boolean; set: <same signature as the store's set> }`.

- [ ] **Step 1: Write the failing reset test**

In `dashboard.test.ts`, import `resetDashboardData` from `./dashboard` and `consumePendingDashboardMutation`, `recordPendingDashboardMutation` from `../utils/dashboard/dashboardMutation`. Add:

```ts
it('resetDashboardData clears store fields and the pending-mutation map', () => {
  useDashboardStore.setState({
    summaries: [makeSummary()],
    summariesLoaded: true,
    dashboard: makeDashboard(),
    loadError: true,
    conflict: true,
  })
  recordPendingDashboardMutation('m-1')

  resetDashboardData()

  const s = useDashboardStore.getState()
  expect(s.summaries).toEqual([])
  expect(s.summariesLoaded).toBe(false)
  expect(s.dashboard).toBeNull()
  expect(s.loadError).toBe(false)
  expect(s.conflict).toBe(false)
  // The stale account's pending-mutation id no longer suppresses an echo.
  expect(consumePendingDashboardMutation('m-1')).toBe(false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/stores/dashboard.test.ts -t "clears store fields"`
Expected: FAIL — `resetDashboardData` is not exported.

- [ ] **Step 3: Add `resetPendingDashboardMutations` to the mutation module**

In `utils/dashboard/dashboardMutation.ts`, replace the test-only reset with a production function it aliases:

```ts
export function resetPendingDashboardMutations(): void {
  pendingDashboardMutationIds.clear()
}

export function __resetPendingDashboardMutationsForTests(): void {
  resetPendingDashboardMutations()
}
```

- [ ] **Step 4: Add the generation counter, guard helper, and `resetDashboardData`**

In `stores/dashboard.ts`:

1. Import the new reset: add `resetPendingDashboardMutations` to the existing import from `../utils/dashboard/dashboardMutation`.
2. After the module-level machinery (`:71`), add:

```ts
// Bumped by resetDashboardData() at every auth boundary. Async store writes capture
// it via sessionGuard() and no-op if it has moved — so a request begun under one
// account can never write into the next account's store.
let sessionGeneration = 0
```

3. Convert the store factory from an object-returning arrow to a block body so the guard can close over the factory's `set`:

```ts
export const useDashboardStore = create<DashboardState>()((set, get) => {
  function sessionGuard() {
    const gen = sessionGeneration
    return {
      isCurrent: () => gen === sessionGeneration,
      set: ((...args: Parameters<typeof set>) => {
        if (gen === sessionGeneration) set(...args)
      }) as typeof set,
    }
  }

  return {
    summaries: [],
    // …all existing initial fields and actions unchanged for now…
  }
})
```

4. After the store definition, add the exported reset:

```ts
export function resetDashboardData(): void {
  sessionGeneration += 1
  if (scheduledSummariesRefreshTimer) {
    clearTimeout(scheduledSummariesRefreshTimer)
  }
  inFlightDashboardLoad = null
  inFlightSummariesLoad = null
  queuedSummariesForceReload = false
  latestDashboardRequest = null
  scheduledSummariesRefreshTimer = null
  scheduledSummariesRefreshPromise = null
  resolveScheduledSummariesRefresh = null
  rejectScheduledSummariesRefresh = null
  resetPendingDashboardMutations()
  useDashboardStore.setState({
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,
  })
}
```

- [ ] **Step 5: Run the reset test to verify it passes**

Run: `npx vitest run src/stores/dashboard.test.ts -t "clears store fields"`
Expected: PASS.

- [ ] **Step 6: Write the failing cross-session write-drop test (loads)**

```ts
it('drops a summaries load that resolves after a reset', async () => {
  let resolveList!: (v: DashboardSummary[]) => void
  apiListDashboards.mockReturnValue(new Promise((r) => { resolveList = r }))

  const loading = useDashboardStore.getState().loadSummaries()
  resetDashboardData() // account boundary while the fetch is in flight

  resolveList([makeSummary()])
  await loading

  // The stale account's summaries must not land in the new session's store.
  expect(useDashboardStore.getState().summaries).toEqual([])
  expect(useDashboardStore.getState().summariesLoaded).toBe(false)
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/stores/dashboard.test.ts -t "resolves after a reset"`
Expected: FAIL — `loadSummaries` still writes `summaries`/`summariesLoaded` after the boundary.

- [ ] **Step 8: Route `loadSummaries` and `loadDashboard` post-await writes through the guard**

In `loadSummaries` (`:312-347`): capture `const guard = sessionGuard()` at the top of the action; keep the pre-await `set({ summariesLoading: true })` as a plain `set`; change the two writes that follow the `await` — the success `set({ summaries: nextSummaries, summariesLoaded: true })` and the `finally` `set({ summariesLoading: false })` — to `guard.set(...)`. (The `inFlightSummariesLoad = null` in `finally` stays; the reset already nulled it, and re-nulling is harmless.)

In `loadDashboard` (`:442-535`): capture `const guard = sessionGuard()` at the top; leave the pre-await `set({ loading: true, loadError: false })` as plain `set`; change every post-await `set(...)` (the success write `:490`, the error write `:510`, and the `finally` write `:519`) to `guard.set(...)`. The existing `isLatestDashboardRequest` serial checks stay — they guard within a session; the generation guards across sessions.

- [ ] **Step 9: Run the write-drop test to verify it passes**

Run: `npx vitest run src/stores/dashboard.test.ts -t "resolves after a reset"`
Expected: PASS.

- [ ] **Step 10: Run the full dashboard suite + typecheck**

Run: `npx vitest run src/stores/dashboard.test.ts && npx tsc --noEmit`
Expected: all PASS (the block-body factory conversion and guard typing compile cleanly).

- [ ] **Step 11: Commit**

```bash
git add frontend/src/stores/dashboard.ts frontend/src/utils/dashboard/dashboardMutation.ts frontend/src/stores/dashboard.test.ts
git commit -m "feat(web): reset dashboard state and guard cross-session writes"
```

---

## Task 2: Extend the guard to every mutation

**Files:**
- Modify: `frontend/src/stores/dashboard.ts:349-629` (the nine mutations)
- Test: `frontend/src/stores/dashboard.test.ts`

**Interfaces:**
- Consumes: `sessionGuard()`, `resetDashboardData()` from Task 1.

- [ ] **Step 1: Write the failing mutation write-drop test**

```ts
it('drops a rename that resolves after a reset', async () => {
  useDashboardStore.setState({ summaries: [makeSummary({ id: 'd1', name: 'A' })] })
  let resolveRename!: (v: DashboardSummary) => void
  apiUpdateDashboardMeta.mockReturnValue(new Promise((r) => { resolveRename = r }))

  const renaming = useDashboardStore.getState().renameDashboard('d1', 'B')
  resetDashboardData()

  resolveRename(makeSummary({ id: 'd1', name: 'B' }))
  await renaming

  // After a boundary the store is empty; a stale rename must not repopulate it.
  expect(useDashboardStore.getState().summaries).toEqual([])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/stores/dashboard.test.ts -t "rename that resolves after a reset"`
Expected: FAIL — `renameDashboard` writes `summaries` after the boundary.

- [ ] **Step 3: Route every mutation's post-await writes through the guard**

For each of `createDashboard`, `archiveDashboard`, `deleteDashboard`, `renameDashboard`, `saveLayout`, `addWidget`, `removeWidget`, `updateWidget`: add `const guard = sessionGuard()` as the first line of the action (before `recordPendingDashboardMutation`), and change every `set(...)` that runs **after** the `await` to `guard.set(...)`. Pre-await reads (`const { dashboard } = get()`) and the `recordPendingDashboardMutation` / `forgetPendingDashboardMutation` bookkeeping stay unchanged (they operate on the map the reset clears).

`toggleFavorite` (`:398-415`) writes **two** stores after its await, so guard both:

```ts
async toggleFavorite(id, current) {
  const guard = sessionGuard()
  try {
    const authState = useAuthStore.getState()
    const currentFavoriteIds = authState.user?.preferences.favorite_dashboard_ids ?? []
    const nextFavoriteIds = current
      ? currentFavoriteIds.filter((favoriteId) => favoriteId !== id)
      : [...currentFavoriteIds.filter((favoriteId) => favoriteId !== id), id]

    const updatedUser = await apiUpdatePreferences({ favorite_dashboard_ids: nextFavoriteIds })
    if (!guard.isCurrent()) return // boundary crossed mid-request — drop both writes
    useAuthStore.setState({ user: updatedUser })
    guard.set((s) => ({
      summaries: s.summaries.map((d) => (d.id === id ? { ...d, is_favorite: !current } : d)),
      dashboard: s.dashboard?.id === id ? { ...s.dashboard, is_favorite: !current } : s.dashboard,
    }))
  } catch {
    toast.error('Failed to update favorite.')
  }
},
```

- [ ] **Step 4: Run the mutation write-drop test to verify it passes**

Run: `npx vitest run src/stores/dashboard.test.ts -t "rename that resolves after a reset"`
Expected: PASS.

- [ ] **Step 5: Verify the SSE handlers need no change**

Confirm by reading `handleDashboardEvent` (`:631-693`) and `handleContentEvent` (`:695-728`): `handleContentEvent` is synchronous; `handleDashboardEvent`'s only direct `set` calls (`:647`, `:664`) run **before** any `await`, and every post-await path delegates to the already-guarded `loadSummaries` / `loadDashboard` and then returns — it performs no direct post-await `set`. No changes required. (No test to add; this step is a read-and-confirm so a future direct post-await `set` here is a conscious choice.)

- [ ] **Step 6: Run the full dashboard suite + typecheck**

Run: `npx vitest run src/stores/dashboard.test.ts && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/stores/dashboard.ts frontend/src/stores/dashboard.test.ts
git commit -m "feat(web): drop stale-session writes from dashboard mutations"
```

---

## Task 3: Unified session reset wired at every auth boundary

**Files:**
- Modify: `frontend/src/stores/auth.ts:41-100` (init, login, verifyEmail, logout)
- Test: `frontend/src/stores/auth.test.ts`

**Interfaces:**
- Consumes: `resetDashboardData()` from Task 1.

- [ ] **Step 1: Write the failing wiring + regression tests**

In `auth.test.ts`, add a hoisted mock and module mock for the dashboard reset (auth imports only this symbol from `./dashboard`, so mocking the module is safe):

```ts
const { resetDashboardData } = vi.hoisted(() => ({ resetDashboardData: vi.fn() }))
vi.mock('./dashboard', () => ({ resetDashboardData }))
```

Then:

```ts
it('resets dashboard state on logout', async () => {
  apiLogout.mockResolvedValue(undefined)
  useAuthStore.setState({ status: 'authenticated', user })
  await useAuthStore.getState().logout()
  expect(resetDashboardData).toHaveBeenCalledTimes(1)
})

it('resets dashboard state when unauthenticated init settles', async () => {
  apiGetMe.mockResolvedValue(null)
  tryRefreshMock.mockResolvedValue('unauthorized')
  await useAuthStore.getState().init()
  expect(resetDashboardData).toHaveBeenCalledTimes(1)
})

it('resets dashboard state on a fresh login, before authenticating', async () => {
  apiLogin.mockResolvedValue(user)
  await useAuthStore.getState().login('user@example.com', 'pw')
  expect(resetDashboardData).toHaveBeenCalledTimes(1)
  expect(useAuthStore.getState().status).toBe('authenticated')
})

it('resets dashboard state on email verification', async () => {
  apiVerifyEmail.mockResolvedValue(user)
  await useAuthStore.getState().verifyEmail('tok')
  expect(resetDashboardData).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/stores/auth.test.ts -t "resets dashboard state"`
Expected: FAIL — login/verifyEmail don't reset, and logout/init don't call `resetDashboardData`.

- [ ] **Step 3: Hoist a shared `resetSessionData` and add the dashboard reset**

In `stores/auth.ts`: add `import { resetDashboardData } from './dashboard'`. Add `resetAgendaData` is already imported. Define one shared reset (module scope, above the store) and use it everywhere:

```ts
function resetSessionData(): void {
  useNotificationsStore.getState().reset()
  resetAgendaData()
  resetCalendarData()
  resetListData()
  resetDashboardData()
}
```

Wire it in:
- `init` unauth path (`:68`): replace the inline `resetSessionData()` closure definition + call with a call to the shared function (remove the closure at `:46-52`).
- `logout` (`:94-97`): replace the four inline resets with `resetSessionData()`.
- `login` (`:77-80`): after `const user = await apiLogin(...)`, call `resetSessionData()` **before** `set({ status: 'authenticated', user })`.
- `verifyEmail` (`:88-91`): after `const user = await apiVerifyEmail(token)`, call `resetSessionData()` **before** `set({ status: 'authenticated', user })`.

- [ ] **Step 4: Run the wiring tests to verify they pass**

Run: `npx vitest run src/stores/auth.test.ts -t "resets dashboard state"`
Expected: PASS.

- [ ] **Step 5: Add the end-to-end account-switch regression test**

This one uses the **real** dashboard store (not the mock), so put it in `dashboard.test.ts` where `./dashboard` is unmocked:

```ts
it('a fresh loadSummaries refetches after a reset (no stale summariesLoaded)', async () => {
  apiListDashboards.mockResolvedValue([makeSummary({ id: 'a' })])
  await useDashboardStore.getState().loadSummaries()
  expect(useDashboardStore.getState().summariesLoaded).toBe(true)

  resetDashboardData() // account boundary

  apiListDashboards.mockResolvedValue([makeSummary({ id: 'b' })])
  await useDashboardStore.getState().loadSummaries()
  // Without the reset, summariesLoaded would short-circuit the second load and
  // the new account would see account A's card.
  expect(useDashboardStore.getState().summaries.map((d) => d.id)).toEqual(['b'])
})
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run src/stores/dashboard.test.ts -t "refetches after a reset"`
Expected: PASS.

- [ ] **Step 7: Full frontend suite, typecheck, lint**

Run: `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: all PASS. (`npm run format` first if Biome reports formatting.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/stores/auth.ts frontend/src/stores/auth.test.ts frontend/src/stores/dashboard.test.ts
git commit -m "fix(web): reset all session state at every auth boundary"
```

---

## Self-review notes (addressed)

- **Type consistency:** `sessionGuard().set` is typed `as typeof set`, matching the store's own setter (accepts both a partial object and an updater function) — every converted call site keeps its existing argument shape.
- **Placeholder scan:** none — each step shows the concrete code or exact command.
- **Spec coverage:** store fields + module machinery + pending-mutation map reset (Task 1); mutation race incl. the cross-store `toggleFavorite` write (Task 2); all four boundaries incl. login/verifyEmail (Task 3); account-switch regression + write-drop tests across all tasks. Matches the design's testing section.
- **Deferred, per spec:** AbortController request cancellation (finding #23 / TanStack Query migration); `ui`/`confirm`/`toast` stores hold non-account state and are untouched.
