# Design — Standardize dashboard mutation success/failure contracts (#10)

**Date:** 2026-07-20
**Status:** ✅ Shipped 2026-07-20 (`b958f04`, `8ef9967`). Phase 3 closed 2026-07-20 (whole-branch review clean); moved to `docs/shipped/` with the plan.
**Finding:** #10 (mutation success and failure contracts are inconsistent). Phase 3 (dashboard
correctness), slice C.

## Problem

Dashboard mutations end their error paths three different ways, and consumers guess wrong:

1. **Toast-and-swallow** (most store actions: `archiveDashboard`, `deleteDashboard`,
   `toggleFavorite`, `renameDashboard`, `addWidget`, `removeWidget`, `updateWidget`). The `await`
   always resolves, so a caller that closes a dialog "after" the mutation closes it on failure too.
2. **Toast-and-rethrow** (`createDashboard`, `dashboard.ts:384` throws `Error('create failed')`).
   Its only consumer awaits it in a `try/finally` with no `catch`, so a failed create is an
   **unhandled promise rejection**.
3. **Component-local try/catch** that bypasses the store (the share handlers in
   `DashboardSettingsModal`, calling `apiAddDashboardShare` etc. directly).

Concrete, verified damage:

| Site | Mechanism | Result on failure |
|------|-----------|-------------------|
| `DashboardEditorPage.tsx:170` | `await addWidget(params); setShowAddWidget(false)` — add swallows | wizard **closes**, selections lost |
| `DashboardSettingsModal.tsx:106` | `await onRename(...); onClose()` — rename swallows | modal **closes**, typed name lost |
| `CreateDashboardModal.tsx:56-68` | `await createDashboard(...)` in `try/finally`, no `catch`; store **rethrows** | **unhandled rejection** |
| `SharePanelAddAccess.tsx:59-65` | `await onAdd(...); setQuery('')` — `handleAddShare` catches, never signals failure | search input **cleared** on a failed add |

The last one resolves the review's open question (#10 validation note: *"the 'failed share adds
clear the search' sub-claim is not in `handleAddShare`… if real, it lives in the share-search
child; verify separately"*) — it is real, in `SharePanelAddAccess` at lines 59-65.

## Decision — one contract: mutations never throw; they resolve to a value that is falsy on failure

- **Value-producing** store mutations resolve `Promise<T | null>` (`null` = failed).
- **Void** store mutations resolve `Promise<boolean>` (`false` = failed).
- The store keeps owning the toast — this matches `frontend/CLAUDE.md` ("errors surface through the
  global `toast` store, not by throwing to components"). Consumers branch on truthiness and only
  close a dialog / clear an input / navigate after a truthy result.

Chosen over the finding's `Result<T>` discriminated union (ceremony this codebase uses nowhere) and
over "always reject" (contradicts the documented toast convention and forces `try/catch` at every
call site). `saveLayout` keeps its existing `Promise<void>` + `conflict`-flag contract — it is not a
dialog-closing mutation and slice B just reworked it; leaving it out avoids reopening that surface.

## Change

### Store — `frontend/src/stores/dashboard.ts`

Adjust return types and the failure `return` in each `catch` (no logic change besides the return
value; `guard.set`, `forgetPendingDashboardMutation`, and `toast.error` stay):

| Action | Now | New | On success `return` | On failure `return` |
|--------|-----|-----|--------------------|--------------------|
| `createDashboard` | `Promise<DashboardSummary>` (throws) | `Promise<DashboardSummary \| null>` | the summary | `null` (delete the `throw`) |
| `archiveDashboard` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `deleteDashboard` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `toggleFavorite` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `renameDashboard` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `addWidget` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `removeWidget` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |
| `updateWidget` | `Promise<void>` | `Promise<boolean>` | `true` | `false` |

The session-generation guard is unchanged: a boundary-crossed mutation already `return`s early
without writing state; it will now `return false`, which is correct (the caller must not act on a
mutation whose result was dropped). Update the `DashboardStore` interface signatures to match.

### Call sites — close/clear/navigate only on success

1. **`DashboardEditorPage.tsx:170`** — `onAdd={async (params) => { if (await addWidget(params)) setShowAddWidget(false) }}`. (Verify `AddWidgetModal` does not itself close on `onAdd` resolving; if it does, thread the boolean back through its `onAdd` prop type so it, too, only closes on success.)
2. **`DashboardSettingsModal.tsx`** — change the `onRename` prop type from `(id, name) => Promise<void>` to `(id, name) => Promise<boolean>`, and at line 106 `if (await onRename(dashboard.id, trimmed)) onClose()`. Callers already pass `renameDashboard`, whose type now matches.
3. **`CreateDashboardModal.tsx:56-68`** — `const summary = await createDashboard(...); if (summary) onCreated(summary)`. With the store no longer throwing, the `try/finally` no longer produces an unhandled rejection; keep `finally { setSubmitting(false) }`.
4. **Share add path** — change `SharePanel`'s `onAdd` prop type (`SharePanel.tsx:43`) to `(share: SharePanelAddPayload) => boolean | Promise<boolean>`; in `SharePanelAddAccess.tsx:59-65`, `const ok = await onAdd(...); if (ok) setQuery('')`. Make `DashboardSettingsModal.handleAddShare` return `true`/`false` (from its existing try/catch). `CreateDashboardModal`'s inline `onAdd` (line 138) adds to local draft state — it cannot fail, so `return true`.

Out of #10's scope (dashboard-only): the list rename handlers (`EditableListName`, `ListItemRow`,
`ListSidebarRow`) share the close-on-failure shape but are a separate resource. Note as a candidate
follow-up; do not change here.

## Testing (Vitest)

**Store (`src/stores/dashboard.test.ts`, `node`).** For a representative value-producing and a
representative void mutation, drive the mocked `api*` to reject and assert the new contract:
- `createDashboard` on API failure resolves **`null`** (not a throw) and toasts; on success resolves
  the summary. (A rejection-not-thrown assertion is the regression guard for the unhandled-rejection
  bug.)
- `addWidget` / `renameDashboard` resolve **`false`** on API failure (toast fired) and **`true`** on
  success.

**Components (`jsdom`).**
- `DashboardSettingsModal`: mock `onRename` to resolve `false`; submit; assert `onClose` was **not**
  called and the field still holds the typed value. Then `true`; assert `onClose` **was** called.
- `CreateDashboardModal`: mock `createDashboard` to resolve `null`; submit; assert `onCreated` was
  **not** called and no unhandled rejection; then a summary; assert `onCreated` fired with it.
- `SharePanelAddAccess`: mock `onAdd` to resolve `false`; assert the query input is **unchanged**;
  then `true`; assert it clears.

Existing tests that call these mutations and ignore the result keep passing (the `void`-discarding
call sites in `DashboardsPage` are unaffected).

## Out of scope

- `saveLayout`'s contract (kept as-is, slice B).
- List/calendar mutation contracts (same shape, different resource) — candidate follow-up.
- #12 (midnight invalidation) — separate Phase 3 slice.

## Execution

Subagent-driven or inline, two tasks for clean review gates: Task 1 = store contract + store tests;
Task 2 = the four call sites + their component tests. Batched into the Phase 3 whole-branch review.
