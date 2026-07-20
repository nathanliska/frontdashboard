# Design — Dashboard layout save correctness (#9 + #11)

**Date:** 2026-07-18
**Status:** ✅ Shipped 2026-07-19 (`e6878ba`; follow-up `910ca63` from the whole-branch review — release the drain flag only for the current session). Phase 3 closed 2026-07-20; moved to `docs/shipped/` with the plan.
**Findings:** #9 (mobile projection overwrites the canonical layout) and #11 (fire-and-forget layout
saves self-conflict / install out of order). Phase 3 (dashboard correctness), slice B. Both live on
the same save path — the `DashboardGrid` layout events and the store's `saveLayout` — so they ship
together.

## Problem

### #9 — the mobile projection pollutes the canonical draft

`DashboardGrid` keeps a canonical `draftLayout` and renders a derived `presentedLayout`: on a narrow
viewport (`isMobile`, `containerWidth < 640`) that derived view is `mobileStackLayout(...)`, which
forces every widget to `x:0, w:1` in a single column. react-grid-layout reports that projected
layout back through `onLayoutChange` → `handleLayoutChange`, which writes it straight into
`draftLayout` **with no `isMobile` guard** (`DashboardGrid.tsx:108-114`) — unlike `handleLayoutStop`,
which already returns early on mobile (`:118`).

Once the projection is in `draftLayout` and `draftBaseVersion === dashboard.version`, `activeLayout`
*is* the one-column projection. Returning to desktop then renders everything stacked, and the next
desktop drag saves that mangled layout over the good one. This is silent destruction of the user's
arrangement.

### #11 — fire-and-forget saves conflict with themselves

`handleLayoutStop` calls `void saveLayout(...)` (`:122`) — unsequenced. `saveLayout` sends
`dashboard.version` as the optimistic base. Two gestures in quick succession both read the *same*
`dashboard.version` (the first response hasn't landed to bump it), so the second save 409s against
the user's **own** first save and raises the conflict banner spuriously; overlapping responses can
also install a stale layout. Every drag/resize starts a naked request with no ordering.

## Decisions

- **#9 — projection is view-only (chosen).** Guard `handleLayoutChange` the same way
  `handleLayoutStop` is guarded, so the mobile stack and read-only renders never write back to the
  canonical `draftLayout`. One canonical layout, no per-breakpoint persistence. Rejected the
  per-breakpoint-layout alternative from the finding as over-engineered at household scale.
- **#11 — serialize + coalesce in the store (chosen), no visible saving UI.** One in-flight save at
  a time plus a single latest-pending layout, drained in `saveLayout`. No saving/saved/failed
  indicator — saves are fast and silent today; failures already `toast`, real conflicts already show
  the banner. The change is purely internal correctness.

## Change

### #9 — `frontend/src/components/dashboard/DashboardGrid.tsx`

Add the guard to `handleLayoutChange` so it ignores library layout events when the layout is a
projection or the dashboard is read-only:

```ts
const handleLayoutChange = useCallback(
  (newLayout: Layout) => {
    if (isMobile || !canEdit) return // projection / read-only: never write back to the canonical draft
    setDraftBaseVersion(dashboard.version)
    setDraftLayout([...newLayout] as unknown as LayoutItem[])
  },
  [canEdit, dashboard.version, isMobile],
)
```

Rendering is unaffected: the grid's `layout` prop is `presentedLayout` (derived), so the mobile
stack still displays; we only stop it from mutating canonical state. `handleLayoutStop` already
carries the identical guard, so desktop editing is unchanged.

The guard's comment must name *why* the write is blocked — the mobile layout is a **derived
projection** (`mobileStackLayout`), not a user-arranged layout — so a future maintainer doesn't read
it as "mobile is permanently uneditable" and delete it. Suggested comment:

```ts
// The mobile layout is a derived projection (mobileStackLayout), not a user arrangement, so it must
// never be persisted. Read-only views likewise can't edit. Enabling real mobile editing later means
// giving mobile its own persisted per-breakpoint layout (see Forward compatibility) — not removing
// this guard.
```

### Forward compatibility — keeping mobile editing an open future change

This design intentionally leaves the door open to editable mobile layouts. The single-canonical-
layout choice is a *scope* decision, not an architectural dead end:

- **The seam is the projection, not `isMobile`.** `presentedLayout` is `mobileStackLayout(activeLayout)`
  on mobile and `activeLayout` on desktop. Persisting is gated on "is this a projection?", which today
  coincides with `isMobile`. When mobile editing is wanted, the change is: give mobile a *real*
  persisted layout instead of a computed projection — at that point mobile's `onLayoutChange` becomes
  a legitimate write and the guard's `isMobile` condition is replaced by "is the current view a
  read-only projection," not deleted wholesale.
- **What that future change would add** (explicitly *not* built now): a per-breakpoint layout store on
  the dashboard (e.g. `layouts: { base, sm, lg }`) so a mobile arrangement can't clobber the desktop
  one, plus enabling `dragConfig`/`resizeConfig` on mobile. That is exactly the "per-breakpoint
  layouts" alternative deferred above — deferred, not precluded.
- **#11 already supports it.** The coalescing `saveLayout` drain is layout-shape-agnostic; a future
  per-breakpoint save reuses the same one-in-flight-plus-latest-pending machinery unchanged.

So nothing here has to be unwound to add mobile editing later — the projection guard is the one line
that would be revisited, and this section is the pointer to how.

### #11 — `frontend/src/stores/dashboard.ts`

Replace the fire-and-forget body of `saveLayout` with a coalescing drain, using module-level state
alongside the existing `inFlightDashboardLoad` machinery:

- Module-level: `let layoutSaveInFlight = false` and
  `let pendingLayoutSave: { dashboardId: string; layout: LayoutItem[] } | null = null`.
- `saveLayout(layout)`: stash `pendingLayoutSave = { dashboardId, layout }` (overwriting any prior
  pending — this is the coalesce), then if a drain is already running, return; otherwise start the
  drain.
- Drain loop (guarded by `const guard = sessionGuard()`): while there's a pending entry, pull it;
  drop it and stop if `!guard.isCurrent()` (auth boundary) or it no longer matches
  `get().dashboard?.id` (dashboard switched). Otherwise record a `clientMutationId`, PUT with the
  **freshly re-read** `dashboard.version`, and:
  - **success** → `guard.set` the returned dashboard (preserving existing `widgets` refs, as today),
    clear `conflict`; loop again (a gesture that arrived mid-flight is now pending with the bumped
    version — no self-conflict);
  - **conflict** (real, another editor) → `forgetPendingDashboardMutation`, drop any pending, set
    `conflict: true`, stop (the banner drives a reload);
  - **throw** → `forgetPendingDashboardMutation`, `toast.error('Failed to save layout.')`, drop
    pending, stop.
- `finally { layoutSaveInFlight = false }`.
- Add `layoutSaveInFlight = false; pendingLayoutSave = null` to `resetDashboardData()` so the save
  state clears at every auth boundary (next to the existing handle resets).

Because each iteration re-reads `dashboard.version` after the prior save bumped it, sequential
gestures never collide, and only the latest coalesced layout is sent. The existing echo-suppression
(`recordPendingDashboardMutation`/`consume…Echo`) is preserved per PUT.

## Testing (Vitest)

**#11 — store (`src/stores/dashboard.test.ts`, `node` env).** Reuse the existing controllable-promise
pattern (`apiUpdateLayout.mockImplementation` returning a promise whose `resolve` is captured;
`makeDashboard`):
- *Coalesce + no self-conflict:* dashboard at version 1. Call `saveLayout(A)` (in flight). Call
  `saveLayout(B)` and `saveLayout(C)` while A is in flight → assert `apiUpdateLayout` was called
  **once** so far (B/C only stashed). Resolve A (→ version 2). Assert the next `apiUpdateLayout` call
  uses **version 2** and layout **C** (B coalesced away), and the final `dashboard` has no `conflict`.
- *Real conflict stops the drain:* in flight save resolves with `{ conflict: true }` → assert
  `conflict` is set and a queued pending layout is dropped (no further `apiUpdateLayout` call).
- *Auth boundary mid-save:* start a save, call `resetDashboardData()` before resolving, then resolve
  → assert no state write leaks (dashboard stays `null`) and the drain does not issue another PUT.
- Existing saveLayout tests (self-echo-reload skip, plain success, conflict banner) stay green.

**#9 — component (`src/components/dashboard/DashboardGrid.test.tsx`, `jsdom` env).** Following the
existing breakpoint test setup: render at a mobile width, fire the grid's `onLayoutChange` with a
one-column projected layout, switch to a desktop width, and assert the rendered/`saveLayout`ed
layout is the **original canonical** layout — never the projection. Add the mirror assertion that a
mobile `onLayoutChange` does not trigger `saveLayout`.

## Out of scope

- Per-breakpoint persisted layouts (#9 alternative) — deliberately not built now, but explicitly
  kept as an open future change (see *Forward compatibility*); the projection guard is the single
  seam that would be revisited.
- A visible layout saving/error indicator (#11 proposal mentions it) — deliberately not built.
- #10 (mutation success/failure contracts) and #12 (midnight invalidation) — separate Phase 3 slices.

## Execution

Subagent-driven, two tasks for clean per-finding review gates: Task 1 = #9 grid guard + component
test; Task 2 = #11 store coalescing + store tests. Batched into the Phase 3 whole-branch review at
phase close.
