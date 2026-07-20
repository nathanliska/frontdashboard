# Dashboard Mutation Contracts (#10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every dashboard store mutation one success/failure contract — never throw; resolve to a value that is falsy on failure — and make the four consumers that close a dialog / clear an input / rethrow act only on success.

**Architecture:** Value-producing store mutations resolve `Promise<T | null>` (`null` = failed); void ones resolve `Promise<boolean>` (`false` = failed). The store keeps owning the toast. See `docs/designs/dashboard-mutation-contracts-design.md`.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest (`node` default, `jsdom` per-file).

## Global Constraints

- The store owns error surfacing (`toast.error`); mutations must not throw and must not surface errors by rejecting (`frontend/CLAUDE.md`).
- Do not change `saveLayout` (kept `Promise<void>` + `conflict` flag, slice B).
- Preserve the session-generation guard: a boundary-crossed mutation already returns without writing state; under the new contract it returns the falsy value.
- Preserve echo-suppression bookkeeping: every existing `forgetPendingDashboardMutation` / `toast.error` call stays exactly where it is.
- Do not touch list/calendar mutation handlers (separate resource).
- Conventional Commit messages, no attribution trailer. Confirm before committing.

---

### Task 1: Store — one contract for every dashboard mutation

**Files:**
- Modify: `frontend/src/stores/dashboard.ts` — the `DashboardStore` interface signatures and eight action bodies
- Test: `frontend/src/stores/dashboard.test.ts`

**Interfaces:**
- Produces: `createDashboard(...) => Promise<DashboardSummary | null>`; `archiveDashboard`, `deleteDashboard`, `toggleFavorite`, `renameDashboard`, `addWidget`, `removeWidget`, `updateWidget` all `=> Promise<boolean>`. `saveLayout` unchanged.

- [ ] **Step 1: Write the failing store tests**

Add to `src/stores/dashboard.test.ts` inside `describe('useDashboardStore', ...)`:

```ts
  it('createDashboard resolves null on API failure instead of throwing (#10)', async () => {
    apiCreateDashboard.mockRejectedValue(new Error('boom'))
    useDashboardStore.setState({ summaries: [] })

    // Must not reject — the regression guard for the unhandled-rejection bug.
    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Failed to create dashboard.')
  })

  it('createDashboard resolves the summary on success (#10)', async () => {
    const summary = makeSummary({ id: 'dash-new', name: 'X' })
    apiCreateDashboard.mockResolvedValue(summary)
    useDashboardStore.setState({ summaries: [] })

    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toEqual(summary)
  })

  it('renameDashboard resolves false on failure and true on success (#10)', async () => {
    useDashboardStore.setState({ summaries: [makeSummary()], dashboard: makeDashboard() })

    apiUpdateDashboardMeta.mockRejectedValueOnce(new Error('boom'))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith('Failed to rename dashboard.')

    apiUpdateDashboardMeta.mockResolvedValueOnce(makeDashboard({ name: 'New' }))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(true)
  })

  it('addWidget resolves false on failure and true on success (#10)', async () => {
    useDashboardStore.setState({ dashboard: makeDashboard() })

    apiAddWidget.mockRejectedValueOnce(new Error('boom'))
    await expect(
      useDashboardStore.getState().addWidget({ widget_type: 'clock' }),
    ).resolves.toBe(false)

    apiAddWidget.mockResolvedValueOnce(makeDashboard({ version: 2 }))
    await expect(
      useDashboardStore.getState().addWidget({ widget_type: 'clock' }),
    ).resolves.toBe(true)
  })
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm test -- src/stores/dashboard.test.ts`
Expected: the four new tests FAIL — today `createDashboard` throws `Error('create failed')` (so `.resolves.toBeNull()` rejects) and the void mutations resolve `undefined`, not `true`/`false`.

- [ ] **Step 3: Update the interface signatures**

In `frontend/src/stores/dashboard.ts`, in the `DashboardStore` type, change:

```ts
  createDashboard: (data: { name: string; shares?: ShareCreate[] }) => Promise<DashboardSummary | null>
  archiveDashboard: (id: string, archived: boolean) => Promise<boolean>
  deleteDashboard: (id: string) => Promise<boolean>
  toggleFavorite: (id: string, current: boolean) => Promise<boolean>
  renameDashboard: (id: string, name: string) => Promise<boolean>
```

and in the Editor actions block:

```ts
  addWidget: (widget: {
    widget_type: string
    config?: Record<string, unknown>
    resource_type?: string | null
    resource_id?: string | null
  }) => Promise<boolean>
  removeWidget: (widgetId: string) => Promise<boolean>
  updateWidget: (widgetId: string, config: Record<string, unknown>) => Promise<boolean>
```

(`saveLayout` stays `Promise<void>`.)

- [ ] **Step 4: Update the action bodies**

`createDashboard` — replace the `catch` throw with a `null` return:

```ts
      } catch {
        forgetPendingDashboardMutation(clientMutationId)
        toast.error('Failed to create dashboard.')
        return null
      }
```

(The success path already `return summary`.)

For each void mutation, add `return true` at the end of the success path and `return false` in the `catch`. Also convert the early-exit returns to the falsy value:

- `archiveDashboard`: after the `guard.set({...})` add `return true`; in `catch` add `return false`.
- `deleteDashboard`: after `guard.set(...)` add `return true`; in `catch` add `return false`.
- `toggleFavorite`: the mid-body `if (!guard.isCurrent()) return` becomes `if (!guard.isCurrent()) return false`; after the final `guard.set(...)` add `return true`; in `catch` add `return false`.
- `renameDashboard`: after `guard.set(...)` add `return true`; in `catch` add `return false`.
- `addWidget`: the `if (!dashboard) return` becomes `if (!dashboard) return false`; after `guard.set({ dashboard: updated })` add `return true`; in `catch` add `return false`.
- `removeWidget`: the `if (!dashboard) return` becomes `if (!dashboard) return false`; after the `guard.set(...)` block add `return true`; in `catch` add `return false`.
- `updateWidget`: the `if (!dashboard) return` becomes `if (!dashboard) return false`; after the `guard.set(...)` block add `return true`; in `catch` add `return false`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test -- src/stores/dashboard.test.ts` → all pass.
Run: `npx tsc -b` → clean (this surfaces any call site whose usage no longer typechecks; the `void`-discarding call sites in `DashboardsPage` and `DashboardGrid`'s `void removeWidget(...)` remain valid).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/stores/dashboard.ts frontend/src/stores/dashboard.test.ts
git commit -m "refactor(dashboards): mutations resolve null/false on failure instead of throwing (#10)"
```

---

### Task 2: Call sites — close / clear / navigate only on success

**Files:**
- Modify: `frontend/src/pages/DashboardEditorPage.tsx` (widget-add handler ~line 170)
- Modify: `frontend/src/components/dashboard/DashboardSettingsModal.tsx` (`onRename` prop type; rename submit ~line 106; `handleAddShare` returns success ~line 144)
- Modify: `frontend/src/components/dashboard/CreateDashboardModal.tsx` (submit ~line 56; inline `onAdd` ~line 138)
- Modify: `frontend/src/components/ui/SharePanel.tsx` (`onAdd` prop type ~line 43)
- Modify: `frontend/src/components/ui/share-panel/SharePanelAddAccess.tsx` (clear on success ~line 59-65)
- Test: `frontend/src/components/dashboard/DashboardSettingsModal.test.tsx`, `CreateDashboardModal.test.tsx`, and `frontend/src/components/ui/share-panel/SharePanelAddAccess.test.tsx` (create any that do not exist; `jsdom`)

**Interfaces:**
- Consumes: the Task 1 store contract (`renameDashboard`/`createDashboard` return values); `AddWidgetModal`'s `onAdd` prop stays `(params) => Promise<void>` (the widget steps only `void onAdd(...)`, so nothing there branches — only the `DashboardEditorPage` inline handler closes).

- [ ] **Step 1: Write the failing component tests**

`DashboardSettingsModal.test.tsx` — a rename that fails keeps the modal open:

```tsx
// @vitest-environment jsdom
// ...render DashboardSettingsModal with onRename resolving false, submit a new name...
// assert onClose NOT called; then onRename resolving true, submit, assert onClose called.
```

`CreateDashboardModal.test.tsx` — a create that fails does not call `onCreated` and does not reject:

```tsx
// onCreated is a vi.fn(); createDashboard prop resolves null; submit;
// assert onCreated NOT called and no unhandled rejection; then resolves a summary; assert onCreated(summary).
```

`SharePanelAddAccess.test.tsx` — a failed add keeps the query:

```tsx
// onAdd resolves false; type a query, click Add; assert the input still holds the query.
// onAdd resolves true; assert the input clears.
```

Match the existing component-test conventions (mock `stores/toast`; `// @vitest-environment jsdom`; query via `@testing-library/react`). Use the exact prop names each component already exposes.

- [ ] **Step 2: Run to confirm the relevant assertions fail**

Run: `npm test -- src/components/dashboard/DashboardSettingsModal.test.tsx src/components/dashboard/CreateDashboardModal.test.tsx src/components/ui/share-panel/SharePanelAddAccess.test.tsx`
Expected: the "stays open" / "not called" / "query preserved" assertions FAIL against current code (the modal closes, `onCreated`/rejection fires, the query clears regardless).

- [ ] **Step 3: Fix `DashboardEditorPage` widget-add handler**

```tsx
          onAdd={async (params: AddWidgetParams) => {
            if (await addWidget(params)) setShowAddWidget(false)
          }}
```

- [ ] **Step 4: Fix `DashboardSettingsModal`**

- Change the prop type: `onRename: (id: string, name: string) => Promise<boolean>`.
- Rename submit (line ~106):

```tsx
      if (await onRename(dashboard.id, trimmed)) onClose()
```

- `handleAddShare` returns a success signal (its existing `try/catch` becomes value-returning):

```tsx
  async function handleAddShare(share: {
    principal_type: SharePanelItem['principal_type']
    principal_id: string
    principal_name: string
    role: ShareRole
  }): Promise<boolean> {
    const clientMutationId = createClientMutationId()
    try {
      const created = await apiAddDashboardShare(
        dashboard.id,
        { principal_type: share.principal_type, principal_id: share.principal_id, role: share.role },
        { clientMutationId },
      )
      setShares((current) => [...current, created])
      return true
    } catch {
      toast.error('Failed to add permission.')
      return false
    }
  }
```

- [ ] **Step 5: Fix `SharePanel` + `SharePanelAddAccess` + `CreateDashboardModal`**

- `SharePanel.tsx:43` prop type: `onAdd: (share: SharePanelAddPayload) => boolean | Promise<boolean>`.
- `SharePanelAddAccess.tsx` (lines ~59-65):

```tsx
      const ok = await onAdd({ /* existing payload */ })
      if (ok) setQuery('')
```

- `CreateDashboardModal.tsx` submit (lines ~56-68):

```tsx
      const summary = await createDashboard({
        name,
        shares: draftShares.map((share) => ({
          principal_id: share.principal_id,
          principal_type: share.principal_type,
          role: share.role,
        })),
      })
      if (summary) onCreated(summary)
```

- `CreateDashboardModal.tsx` inline `onAdd` (line ~138) adds to local draft state and cannot fail — end it with `return true` so it satisfies the `boolean | Promise<boolean>` prop.

- [ ] **Step 6: Run the tests + typecheck**

Run: `npm test -- src/components/dashboard/DashboardSettingsModal.test.tsx src/components/dashboard/CreateDashboardModal.test.tsx src/components/ui/share-panel/SharePanelAddAccess.test.tsx` → all pass.
Run: `npx tsc -b` → clean.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint`
```bash
git add frontend/src/pages/DashboardEditorPage.tsx frontend/src/components/dashboard/DashboardSettingsModal.tsx frontend/src/components/dashboard/CreateDashboardModal.tsx frontend/src/components/ui/SharePanel.tsx frontend/src/components/ui/share-panel/SharePanelAddAccess.tsx frontend/src/components/dashboard/DashboardSettingsModal.test.tsx frontend/src/components/dashboard/CreateDashboardModal.test.tsx frontend/src/components/ui/share-panel/SharePanelAddAccess.test.tsx
git commit -m "fix(dashboards): keep dialogs open and inputs intact when a mutation fails (#10)"
```

---

## Self-Review

- **Spec coverage:** contract = Task 1; the four verified damage sites (widget-add close, rename close, create unhandled-rejection, share-search clear) = Task 2 Steps 3-5, each with a failing-first test in Step 1.
- **Placeholder scan:** the three component tests are described by behavior, not literal code, because they must match each component's existing render/prop conventions — the executor writes them against the real components. Every store edit and call-site edit is literal.
- **Type consistency:** store returns (`DashboardSummary | null`, `boolean`) match the interface block in Task 1 Step 3; `onRename` (`Promise<boolean>`) and `onAdd` (`boolean | Promise<boolean>`) match their consumers; `tsc -b` in both tasks is the net.
