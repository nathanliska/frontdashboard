# Session-Boundary Guard for Auth + Notifications Stores — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the same-tab cross-account write vectors in the auth store (#46) and notifications
store (#47), and fix the logout ordering window (#48), by extending the dashboard store's proven
session-generation guard to those stores via one shared counter.

**Architecture:** A new `stores/sessionGeneration.ts` holds a single monotonic counter
(`bumpSessionGeneration` / `currentSessionGeneration`). The dashboard store migrates its private
counter onto it (behavior-preserving). The notifications and auth stores capture the counter at each
async action's entry and drop the post-`await` write if it moved. `logout()` tears down the session
view before its network round-trip.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest (default **node** env for store tests), Biome.

**Source spec:** `docs/designs/session-boundary-guard-design.md`.

## Global Constraints

- **One shared counter.** All three stores (dashboard, auth, notifications) read
  `currentSessionGeneration()` from `stores/sessionGeneration.ts`. Correctness only requires the
  counter to advance at least once per boundary; each store's reset bumps it, and `resetSessionData()`
  always calls those resets.
- **The dashboard migration is behavior-preserving.** `resetDashboardData()` still bumps (so every
  existing `dashboard.test.ts` call site passes unchanged); only the counter's home moves. No
  dashboard call-site or test changes.
- **Guard only post-`await` writes.** Synchronous writes (`addFromSse`, `setPanelOpen`, boundary
  writes in `login`/`verifyEmail`, optimistic pre-await writes) stay plain `set`. `changePassword`
  writes no `user`, so it is not guarded.
- Store tests run in the **node** environment (no jsdom); mock `api/*` modules with `vi.hoisted` +
  `vi.mock`, matching `auth.test.ts` / `dashboard.test.ts`.

---

### Task 1: Shared generation primitive + dashboard migration

Create the shared counter and move the dashboard store onto it. This is a behavior-preserving
refactor; the dashboard store's existing test suite is the regression net.

**Files:**
- Create: `frontend/src/stores/sessionGeneration.ts`
- Create: `frontend/src/stores/sessionGeneration.test.ts`
- Modify: `frontend/src/stores/dashboard.ts` (remove private counter; use the shared one)

**Interfaces:**
- Produces: `bumpSessionGeneration(): void`, `currentSessionGeneration(): number`.

- [ ] **Step 1: Write the primitive's unit test**

Create `frontend/src/stores/sessionGeneration.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'

describe('sessionGeneration', () => {
  it('advances monotonically on each bump', () => {
    const start = currentSessionGeneration()
    bumpSessionGeneration()
    expect(currentSessionGeneration()).toBe(start + 1)
    bumpSessionGeneration()
    expect(currentSessionGeneration()).toBe(start + 2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npm test -- src/stores/sessionGeneration.test.ts`
Expected: FAIL — module `./sessionGeneration` does not exist.

- [ ] **Step 3: Create the primitive**

Create `frontend/src/stores/sessionGeneration.ts`:

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

- [ ] **Step 4: Migrate the dashboard store onto the shared counter**

In `frontend/src/stores/dashboard.ts`:

Add the import near the other store imports:
```ts
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'
```

Remove the private counter (the comment block + `let sessionGeneration = 0`, currently ~lines 78-81).

In `resetDashboardData()`, replace `sessionGeneration += 1` with:
```ts
  bumpSessionGeneration()
```

Replace the `sessionGuard()` factory (currently ~lines 312-320) with the shared-counter version:
```ts
  function sessionGuard() {
    const gen = currentSessionGeneration()
    return {
      isCurrent: () => gen === currentSessionGeneration(),
      set: ((...args: Parameters<typeof set>) => {
        if (gen === currentSessionGeneration()) set(...args)
      }) as typeof set,
    }
  }
```

- [ ] **Step 5: Run the primitive test + the full dashboard/auth suites**

Run: `cd frontend && npm test -- src/stores/sessionGeneration.test.ts src/stores/dashboard.test.ts src/stores/auth.test.ts`
Expected: PASS — the primitive test passes and every existing dashboard + auth store test stays green
(the migration is behavior-preserving; `resetDashboardData()` still bumps).

- [ ] **Step 6: Typecheck + lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: clean (fix and re-run if not).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/stores/sessionGeneration.ts frontend/src/stores/sessionGeneration.test.ts frontend/src/stores/dashboard.ts
git commit -m "refactor(web): extract shared session-generation counter for the dashboard store"
```

---

### Task 2: Guard the auth store's user writes (#46) + fix logout ordering (#48)

**Files:**
- Modify: `frontend/src/stores/auth.ts` (guard `updateProfile`/`updatePreferences`; reorder `logout`)
- Modify: `frontend/src/stores/auth.test.ts` (cross-session-drop + logout-ordering tests)

**Interfaces:**
- Consumes: `currentSessionGeneration` from `stores/sessionGeneration.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/stores/auth.test.ts`. It already imports `useAuthStore`, `vi`, and mocks
`apiUpdateProfile`/`apiUpdatePreferences`/`apiLogout` via `vi.hoisted`. Add at the top-level imports:
```ts
import { bumpSessionGeneration } from './sessionGeneration'
```

Add these tests (use the existing hoisted mock names; `USER_A`/`USER_B` are minimal `User` objects —
reuse whatever `User` shape the file already builds, e.g. `{ id, email, display_name, preferences }`):

```ts
it('drops a profile update whose response lands after a session boundary', async () => {
  const USER_B = { id: 'b', email: 'b@x.com', display_name: 'B', preferences: {} } as User
  useAuthStore.setState({ status: 'authenticated', user: USER_B })

  let resolveUpdate!: (u: User) => void
  apiUpdateProfile.mockReturnValue(new Promise<User>((r) => { resolveUpdate = r }))

  const pending = useAuthStore.getState().updateProfile({ display_name: 'A-new' })
  bumpSessionGeneration() // account boundary crosses while the request is in flight
  resolveUpdate({ id: 'a', email: 'a@x.com', display_name: 'A-new', preferences: {} } as User)
  await pending

  expect(useAuthStore.getState().user).toBe(USER_B) // A's response was dropped
})

it('drops a preferences update whose response lands after a session boundary', async () => {
  const USER_B = { id: 'b', email: 'b@x.com', display_name: 'B', preferences: {} } as User
  useAuthStore.setState({ status: 'authenticated', user: USER_B })

  let resolveUpdate!: (u: User) => void
  apiUpdatePreferences.mockReturnValue(new Promise<User>((r) => { resolveUpdate = r }))

  const pending = useAuthStore.getState().updatePreferences({} as never)
  bumpSessionGeneration()
  resolveUpdate({ id: 'a', email: 'a@x.com', display_name: 'A', preferences: {} } as User)
  await pending

  expect(useAuthStore.getState().user).toBe(USER_B)
})

it('marks the session unauthenticated before apiLogout resolves', async () => {
  useAuthStore.setState({ status: 'authenticated', user: { id: 'b' } as User })
  let resolveLogout!: () => void
  apiLogout.mockReturnValue(new Promise<void>((r) => { resolveLogout = r }))

  const pending = useAuthStore.getState().logout()
  expect(useAuthStore.getState().status).toBe('unauthenticated')
  expect(useAuthStore.getState().user).toBeNull()

  resolveLogout()
  await pending
})
```

If the file resets store state between tests (`beforeEach`/`afterEach`), keep those; set the initial
`user`/`status` explicitly in each test as above so they're independent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/stores/auth.test.ts`
Expected: FAIL — without the guard, the profile/preferences tests see `user` overwritten with A
(`toBe(USER_B)` fails), and the logout test sees `status` still `authenticated` before `apiLogout`
resolves (reset-then-await-then-set order).

- [ ] **Step 3: Guard the two user writes**

In `frontend/src/stores/auth.ts`, add the import:
```ts
import { currentSessionGeneration } from './sessionGeneration'
```

`updatePreferences`:
```ts
  async updatePreferences(prefs) {
    const gen = currentSessionGeneration()
    try {
      const updated = await apiUpdatePreferences(prefs)
      if (gen !== currentSessionGeneration()) return // boundary crossed mid-request — drop the write
      set({ user: updated })
    } catch {
      toast.error('Failed to update preferences.')
    }
  },
```

`updateProfile`:
```ts
  async updateProfile(input) {
    const gen = currentSessionGeneration()
    try {
      const updated = await apiUpdateProfile(input)
      if (gen !== currentSessionGeneration()) return // boundary crossed mid-request — drop the write
      set({ user: updated })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile.')
      throw err
    }
  },
```

- [ ] **Step 4: Reorder `logout()`**

Replace `logout()` with:
```ts
  async logout() {
    set({ status: 'unauthenticated', user: null }) // closes the SSE stream via useSSE cleanup
    resetSessionData()                              // clears stores + bumps the generation
    await apiLogout().catch(() => {})
  },
```

- [ ] **Step 5: Run the auth suite**

Run: `cd frontend && npm test -- src/stores/auth.test.ts`
Expected: PASS — the three new tests pass and all existing auth store tests (boundary wiring, login,
verifyEmail, changePassword) stay green.

- [ ] **Step 6: Typecheck + lint**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/stores/auth.ts frontend/src/stores/auth.test.ts
git commit -m "fix(web): guard auth store user writes at the session boundary and tear down session before logout"
```

---

### Task 3: Guard the notifications store's async writes (#47)

**Files:**
- Modify: `frontend/src/stores/notifications.ts` (bump on `reset()`; guard post-await writes)
- Create: `frontend/src/stores/notifications.test.ts`

**Interfaces:**
- Consumes: `bumpSessionGeneration`, `currentSessionGeneration` from `stores/sessionGeneration.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/stores/notifications.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notification } from '../api/notifications'

const { apiGetNotifications, apiGetUnreadCount, apiMarkAllRead, apiMarkRead } = vi.hoisted(() => ({
  apiGetNotifications: vi.fn(),
  apiGetUnreadCount: vi.fn(),
  apiMarkAllRead: vi.fn(),
  apiMarkRead: vi.fn(),
}))
vi.mock('../api/notifications', () => ({
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
}))

import { useNotificationsStore } from './notifications'
import { bumpSessionGeneration } from './sessionGeneration'

const NOTIF_A: Notification = { id: 'a', read_at: null } as Notification

beforeEach(() => {
  vi.clearAllMocks()
  useNotificationsStore.getState().reset()
})

describe('notifications store session-boundary guard', () => {
  it('drops a load whose response lands after a session boundary', async () => {
    let resolveLoad!: (n: Notification[]) => void
    apiGetNotifications.mockReturnValue(new Promise<Notification[]>((r) => { resolveLoad = r }))

    const pending = useNotificationsStore.getState().load()
    bumpSessionGeneration() // account boundary while the fetch is in flight
    resolveLoad([NOTIF_A])
    await pending

    expect(useNotificationsStore.getState().notifications).toEqual([]) // A's list was dropped
    expect(useNotificationsStore.getState().loaded).toBe(false)
  })

  it('drops a markRead whose response lands after a session boundary', async () => {
    useNotificationsStore.setState({ notifications: [NOTIF_A], unreadCount: 1 })
    let resolveMark!: (n: Notification) => void
    apiMarkRead.mockReturnValue(new Promise<Notification>((r) => { resolveMark = r }))

    const pending = useNotificationsStore.getState().markRead('a')
    bumpSessionGeneration()
    resolveMark({ id: 'a', read_at: '2026-07-17T00:00:00Z' } as Notification)
    await pending

    expect(useNotificationsStore.getState().unreadCount).toBe(1) // markRead write dropped
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npm test -- src/stores/notifications.test.ts`
Expected: FAIL — without the guard, `load` writes A's notifications (`loaded` becomes `true`,
`notifications` non-empty) and `markRead` decrements `unreadCount` to 0.

- [ ] **Step 3: Add the guard to the notifications store**

In `frontend/src/stores/notifications.ts`:

Add the import:
```ts
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'
```

Convert the store factory to a block body with a `sessionGuard` helper (mirrors the dashboard store):
```ts
export const useNotificationsStore = create<NotificationsState>()((set, get) => {
  function sessionGuard() {
    const gen = currentSessionGeneration()
    return {
      set: ((...args: Parameters<typeof set>) => {
        if (gen === currentSessionGeneration()) set(...args)
      }) as typeof set,
    }
  }

  return {
    notifications: [],
    unreadCount: 0,
    panelOpen: false,
    loaded: false,
    // …actions below…
  }
})
```

Route each post-`await` write through a per-action guard captured at entry:
- `load`: `const guard = sessionGuard()` at the top of the async IIFE (before the `await`), then
  `guard.set({ notifications, unreadCount, loaded: true })`.
- `loadUnreadCount`: `const guard = sessionGuard()` before the `await`, then `guard.set({ unreadCount: count })`.
- `markRead`: `const guard = sessionGuard()` at the top, then `guard.set((s) => ({ … }))`.
- `markAllRead`: `const guard = sessionGuard()` at the top, then `guard.set((s) => ({ … }))`.

Leave `addFromSse` and `setPanelOpen` as plain `set` (synchronous — no straddle).

In `reset()`, add `bumpSessionGeneration()` (keep the existing promise-handle nulling + state clear):
```ts
  reset() {
    bumpSessionGeneration()
    notificationsPromise = null
    unreadCountPromise = null
    set({ notifications: [], unreadCount: 0, panelOpen: false, loaded: false })
  },
```

- [ ] **Step 4: Run the notifications test**

Run: `cd frontend && npm test -- src/stores/notifications.test.ts`
Expected: PASS — both cross-session-drop tests pass.

- [ ] **Step 5: Run the full store suite + typecheck + lint**

Run: `cd frontend && npm test -- src/stores && npx tsc --noEmit && npm run lint`
Expected: PASS/clean — all store tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/stores/notifications.ts frontend/src/stores/notifications.test.ts
git commit -m "fix(web): guard notifications store writes at the session boundary"
```

---

## Self-Review

- **Spec coverage:** shared primitive + dashboard migration (T1); auth `set({user})` guard + logout
  ordering (T2, #46/#48); notifications guard + reset bump (T3, #47). Each design section maps to a task.
- **Type consistency:** `bumpSessionGeneration`/`currentSessionGeneration` defined in T1 and consumed
  by dashboard (T1), auth (T2), notifications (T3). The `sessionGuard` shape matches the dashboard
  store's existing one.
- **Task boundaries:** T1 is a behavior-preserving refactor gated by the existing dashboard suite; T2
  and T3 each end green with their own new tests and both depend only on T1's primitive.
- **Behavior preservation:** `resetDashboardData()` still bumps, so no dashboard test changes; guards
  wrap only post-`await` writes; `changePassword` and synchronous writes are untouched.
- **No placeholders:** every code step carries complete code and an exact command with expected output.
- **Test env:** store tests are node-env (no jsdom directive needed), mocking `api/*` per the existing
  `auth.test.ts`/`dashboard.test.ts` convention.
