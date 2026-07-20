# Dashboard Layout Save Correctness (#9 + #11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the mobile projection from overwriting the canonical dashboard layout (#9), and serialize/coalesce layout saves so rapid edits don't self-conflict or install out of order (#11).

**Architecture:** Two independent frontend changes on the same save path. #9 is a guard in `DashboardGrid.handleLayoutChange`. #11 turns the store's `saveLayout` into a one-in-flight + one-latest-pending drain. See `docs/designs/dashboard-layout-save-correctness-design.md`.

**Tech Stack:** React 19 + TypeScript, Zustand, react-grid-layout v2, Vitest (`node` default, `jsdom` opt-in per file).

## Global Constraints

- One canonical layout only — no per-breakpoint persistence (deferred, kept as an open future change; the projection guard is the single seam). The mobile view stays a derived projection (`mobileStackLayout`).
- No visible saving/error indicator — failures already `toast`, real conflicts already show the banner.
- Preserve existing echo suppression: each real PUT records a `clientMutationId` via `recordPendingDashboardMutation` and calls `forgetPendingDashboardMutation` on the non-success paths.
- On a layout save, keep the existing "preserve existing `widgets` refs" behavior so memoized widget subtrees aren't invalidated (`frontend/CLAUDE.md`).
- `apiFetch`/`ApiError` conventions unchanged; don't touch `api/dashboards.ts`.
- Conventional Commit messages, no attribution trailer. Confirm before committing.

---

### Task 1: #9 — mobile projection must not pollute the canonical layout

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardGrid.tsx` (`handleLayoutChange`, currently lines 108-114)
- Test: `frontend/src/components/dashboard/DashboardGrid.test.tsx` (enhance the `react-grid-layout` + `ResizeObserver` mocks to expose the `layout` prop / `onLayoutChange` callback / a drivable width; add two tests)

**Interfaces:**
- Consumes: `DashboardGrid({ dashboard, canEdit })`; the grid renders `presentedLayout` (`isMobile ? mobileStackLayout(activeLayout) : activeLayout`) into the library's `layout` prop and calls `onLayoutChange` on layout events.
- Produces: no interface change; behavior only.

- [ ] **Step 1: Enhance the test harness and write the two failing tests**

Replace the top-of-file mocks in `DashboardGrid.test.tsx` so the grid mock records the `layout` prop and the `onLayoutChange` callback, and the `ResizeObserver` mock is drivable. Keep the existing `data-child-types` behavior so the current two tests keep passing.

Replace lines 1-53 (imports through `makeDashboard`) with:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dashboard, LayoutItem } from '../../api/dashboards'
import { DashboardGrid } from './DashboardGrid'

const gridSpy = vi.hoisted(() => ({
  lastLayout: null as unknown as LayoutItem[],
  onLayoutChange: null as null | ((layout: unknown) => void),
}))

const resizeSpy = vi.hoisted(() => ({
  cb: null as null | ((entries: { contentRect: { width: number } }[]) => void),
}))

vi.mock('react-grid-layout', () => {
  function MockGridLayout({
    children,
    layout,
    onLayoutChange,
  }: {
    children: React.ReactNode
    layout: LayoutItem[]
    onLayoutChange?: (layout: unknown) => void
  }) {
    gridSpy.lastLayout = layout
    gridSpy.onLayoutChange = onLayoutChange ?? null
    const childTypes = React.Children.toArray(children).map((child) => {
      if (!React.isValidElement(child)) return typeof child
      return typeof child.type === 'string'
        ? child.type
        : ((child.type as { displayName?: string; name?: string }).displayName ??
            (child.type as { displayName?: string; name?: string }).name ??
            'component')
    })
    return (
      <div data-testid="grid" data-child-types={childTypes.join(',')}>
        {children}
      </div>
    )
  }
  return { GridLayout: MockGridLayout }
})

class MockResizeObserver {
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    resizeSpy.cb = cb
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver

function setWidth(width: number): void {
  act(() => {
    resizeSpy.cb?.([{ contentRect: { width } }])
  })
}

function makeDashboard(): Dashboard {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Shared Board',
    archived: false,
    is_shared: true,
    can_edit: false,
    can_manage_shares: false,
    is_favorite: false,
    layout: [],
    version: 1,
    widgets: [],
  }
}

const TWO_WIDGETS = [
  {
    id: 'widget-1',
    dashboard_id: 'dash-1',
    widget_type: 'clock' as const,
    widget_version: 1,
    config: {},
    resource_type: null,
    resource_id: null,
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
  },
  {
    id: 'widget-2',
    dashboard_id: 'dash-1',
    widget_type: 'clock' as const,
    widget_version: 1,
    config: {},
    resource_type: null,
    resource_id: null,
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
  },
]

const CANONICAL_LAYOUT: LayoutItem[] = [
  { i: 'widget-1', x: 0, y: 0, w: 4, h: 3 },
  { i: 'widget-2', x: 4, y: 0, w: 4, h: 3 },
]
```

Then add these two tests inside `describe('DashboardGrid', ...)`:

```tsx
  it('does not let the mobile projection overwrite the canonical layout (#9)', () => {
    render(
      <DashboardGrid
        dashboard={{ ...makeDashboard(), can_edit: true, layout: CANONICAL_LAYOUT, widgets: TWO_WIDGETS }}
        canEdit
      />,
    )

    // Narrow viewport → the library renders the one-column projection.
    setWidth(400)
    expect(gridSpy.lastLayout.every((item) => item.x === 0 && item.w === 1)).toBe(true)

    // The library echoes that projection back through onLayoutChange.
    act(() => gridSpy.onLayoutChange?.(gridSpy.lastLayout))

    // Back to desktop: the canonical arrangement must be intact, not the projection.
    setWidth(1200)
    const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
    expect(byId.get('widget-2')).toMatchObject({ x: 4, w: 4 })
    expect(byId.get('widget-1')).toMatchObject({ x: 0, w: 4 })
  })

  it('still accepts desktop layout edits (guard does not over-block) (#9)', () => {
    render(
      <DashboardGrid
        dashboard={{ ...makeDashboard(), can_edit: true, layout: CANONICAL_LAYOUT, widgets: TWO_WIDGETS }}
        canEdit
      />,
    )
    setWidth(1200) // desktop
    const edited = [
      { i: 'widget-1', x: 2, y: 0, w: 4, h: 3 },
      { i: 'widget-2', x: 6, y: 0, w: 4, h: 3 },
    ]
    act(() => gridSpy.onLayoutChange?.(edited))
    const byId = new Map(gridSpy.lastLayout.map((item) => [item.i, item]))
    expect(byId.get('widget-1')).toMatchObject({ x: 2 })
  })
```

- [ ] **Step 2: Run the tests to verify the regression test fails**

Run: `npm test -- src/components/dashboard/DashboardGrid.test.tsx`
Expected: the `#9` projection test FAILS — without the guard, the mobile `onLayoutChange` writes the projection into `draftLayout`, so after switching to desktop `widget-2` is `{ x: 0, w: 1 }`, not `{ x: 4, w: 4 }`. (The "desktop edits" test and the two pre-existing tests pass.)

- [ ] **Step 3: Add the guard**

In `frontend/src/components/dashboard/DashboardGrid.tsx`, change `handleLayoutChange` to ignore projected / read-only layout events:

```tsx
  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      // The mobile layout is a derived projection (mobileStackLayout), not a user arrangement, so it
      // must never be persisted; read-only views likewise can't edit. Enabling real mobile editing
      // later means giving mobile its own persisted per-breakpoint layout (see
      // docs/designs/dashboard-layout-save-correctness-design.md) — not removing this guard.
      if (isMobile || !canEdit) return
      setDraftBaseVersion(dashboard.version)
      setDraftLayout([...newLayout] as unknown as LayoutItem[])
    },
    [canEdit, dashboard.version, isMobile],
  )
```

- [ ] **Step 4: Run the tests to verify all pass**

Run: `npm test -- src/components/dashboard/DashboardGrid.test.tsx`
Expected: all four tests PASS.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint -- src/components/dashboard/DashboardGrid.tsx src/components/dashboard/DashboardGrid.test.tsx`
Then:

```bash
git add frontend/src/components/dashboard/DashboardGrid.tsx frontend/src/components/dashboard/DashboardGrid.test.tsx
git commit -m "fix(dashboards): stop mobile projection overwriting the canonical layout (#9)"
```

---

### Task 2: #11 — serialize and coalesce layout saves

**Files:**
- Modify: `frontend/src/stores/dashboard.ts` (add two module-level vars near `inFlightDashboardLoad`; rewrite the `saveLayout` action; clear the two vars in `resetDashboardData`)
- Test: `frontend/src/stores/dashboard.test.ts` (add three tests; reuse `makeDashboard`, hoisted `apiUpdateLayout`, `resetDashboardData`)

**Interfaces:**
- Consumes: `apiUpdateLayout(id, layout, version, { clientMutationId }) → { conflict: true } | { conflict: false; dashboard: Dashboard }`; `sessionGuard()` returning `{ isCurrent(): boolean, set: typeof set }`; `recordPendingDashboardMutation`/`forgetPendingDashboardMutation`; `createClientMutationId`; `toast`.
- Produces: `saveLayout(layout: LayoutItem[]): Promise<void>` — same signature; now serialized + coalesced. The returned promise resolves when the drain it owns (if any) finishes; a call made while a drain is running resolves immediately after stashing.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/stores/dashboard.test.ts` inside `describe('useDashboardStore', ...)`:

```ts
  it('coalesces rapid layout saves and re-reads the bumped version (#11)', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const layoutA = [{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }]
    const layoutB = [{ i: 'w1', x: 2, y: 0, w: 4, h: 3 }]
    const layoutC = [{ i: 'w1', x: 3, y: 0, w: 4, h: 3 }]

    const pA = useDashboardStore.getState().saveLayout(layoutA)
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(1, 'dash-1', layoutA, 1, expect.anything())

    // B then C arrive while A is in flight → only the latest (C) is retained.
    useDashboardStore.getState().saveLayout(layoutB)
    useDashboardStore.getState().saveLayout(layoutC)
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1)

    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2, layout: layoutA }) })
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(2))
    // Second PUT uses the bumped version 2 and the coalesced latest layout C (B dropped).
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(2, 'dash-1', layoutC, 2, expect.anything())

    resolvers[1]({ conflict: false, dashboard: makeDashboard({ version: 3, layout: layoutC }) })
    await pA
    expect(useDashboardStore.getState().conflict).toBe(false)
    expect(useDashboardStore.getState().dashboard?.version).toBe(3)
  })

  it('stops the drain and drops pending on a real conflict (#11)', async () => {
    const resolvers: ((v: { conflict: true }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const pA = useDashboardStore.getState().saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))
    useDashboardStore.getState().saveLayout([{ i: 'w1', x: 2, y: 0, w: 4, h: 3 }]) // pending

    resolvers[0]({ conflict: true })
    await pA
    expect(useDashboardStore.getState().conflict).toBe(true)
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1) // pending dropped, never sent
  })

  it('drops the layout save when the session resets mid-flight (#11)', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const pA = useDashboardStore.getState().saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))

    resetDashboardData() // account boundary — bumps sessionGeneration, clears dashboard + save state
    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2 }) })
    await pA

    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1) // no second PUT after reset
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/stores/dashboard.test.ts`
Expected: the coalesce test FAILS — today both in-flight saves fire immediately (no serialization), so `apiUpdateLayout` is called 3 times right away and the "called once / nth-called with version 2" assertions fail. (The conflict and reset tests may pass incidentally today; they lock in the new behavior.)

- [ ] **Step 3: Add the module-level save state**

In `frontend/src/stores/dashboard.ts`, next to the existing `let inFlightDashboardLoad ...` / `let inFlightSummariesLoad ...` declarations (~line 70), add:

```ts
let layoutSaveInFlight = false
let pendingLayoutSave: { dashboardId: string; layout: LayoutItem[] } | null = null
```

- [ ] **Step 4: Rewrite `saveLayout` as a coalescing drain**

Replace the entire existing `async saveLayout(layout) { ... }` action with:

```ts
    async saveLayout(layout) {
      const { dashboard } = get()
      if (!dashboard) return
      // Coalesce: always record the latest requested layout, overwriting any prior pending one.
      pendingLayoutSave = { dashboardId: dashboard.id, layout }
      // Serialize: one drain at a time. A concurrent call just updated pendingLayoutSave above and
      // the running drain will pick it up with the freshly-bumped version.
      if (layoutSaveInFlight) return
      layoutSaveInFlight = true
      const guard = sessionGuard()
      try {
        while (pendingLayoutSave) {
          if (!guard.isCurrent()) return
          const pending = pendingLayoutSave
          pendingLayoutSave = null
          const current = get().dashboard
          if (!current || current.id !== pending.dashboardId) continue // switched dashboards — drop
          const clientMutationId = createClientMutationId()
          recordPendingDashboardMutation(clientMutationId)
          try {
            const result = await apiUpdateLayout(current.id, pending.layout, current.version, {
              clientMutationId,
            })
            if (!guard.isCurrent()) {
              forgetPendingDashboardMutation(clientMutationId)
              return
            }
            if (result.conflict) {
              // Another editor saved between our load and this PUT. Surface the banner and drop any
              // coalesced pending — resolution is a reload.
              forgetPendingDashboardMutation(clientMutationId)
              pendingLayoutSave = null
              guard.set({ conflict: true })
              return
            }
            guard.set((s) => ({
              dashboard: {
                ...result.dashboard,
                // Layout saves don't touch widget data. Preserve existing widget references so
                // memoized widget subtrees aren't invalidated on drag/resize.
                widgets: s.dashboard?.widgets ?? result.dashboard.widgets,
              },
              conflict: false,
            }))
          } catch {
            forgetPendingDashboardMutation(clientMutationId)
            pendingLayoutSave = null
            toast.error('Failed to save layout.')
            return
          }
        }
      } finally {
        layoutSaveInFlight = false
      }
    },
```

- [ ] **Step 5: Clear the save state at the auth boundary**

In `resetDashboardData()` (~line 773), alongside `inFlightDashboardLoad = null`, add:

```ts
  layoutSaveInFlight = false
  pendingLayoutSave = null
```

- [ ] **Step 6: Run the tests to verify all pass**

Run: `npm test -- src/stores/dashboard.test.ts`
Expected: all tests PASS, including the pre-existing `skips the in-flight layout self-echo reload while saving layout` and any existing conflict/success saveLayout tests.

- [ ] **Step 7: Typecheck, lint, and commit**

Run: `npm run lint -- src/stores/dashboard.ts src/stores/dashboard.test.ts`
Then:

```bash
git add frontend/src/stores/dashboard.ts frontend/src/stores/dashboard.test.ts
git commit -m "fix(dashboards): serialize and coalesce layout saves to avoid self-conflicts (#11)"
```

---

## Self-Review

- **Spec coverage:** #9 guard = Task 1 Step 3; #9 tests = Task 1 Step 1. #11 serialize/coalesce = Task 2 Steps 3-4; #11 reset-clearing = Step 5; #11 tests = Step 1 (coalesce+version, conflict-drops-pending, auth-boundary). Forward-compat (single seam) honored by the guard comment referencing the design doc.
- **Placeholder scan:** none — all code is literal.
- **Type consistency:** `pendingLayoutSave: { dashboardId: string; layout: LayoutItem[] }`; `saveLayout(layout: LayoutItem[])`; `apiUpdateLayout(id, layout, version, opts)` matches the current call. `guard.isCurrent()`/`guard.set` match `sessionGuard()`. Test uses `vi.waitFor` to avoid microtask-timing flakiness. `LayoutItem` imported in the grid test for the harness types.
- **Note for executor:** run the full `npm test` and `npm run lint` before the final commit of the last task, since the store change is imported broadly.
