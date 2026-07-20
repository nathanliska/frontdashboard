# Design — Invalidate time-dependent dashboard data at local midnight (#12)

**Date:** 2026-07-20
**Status:** ✅ Shipped 2026-07-20 (`26937c0`, `8c88545`). Phase 3 closed 2026-07-20 (whole-branch review clean); moved to `docs/shipped/` with the plan.
**Finding:** #12 (time-dependent dashboard data is not invalidated at local midnight). Phase 3
(dashboard correctness), slice D — the last Phase 3 slice.

## Problem

An always-on household wall display can show *yesterday's* agenda and calendar indefinitely after
midnight, because "today" is frozen in three places and nothing re-renders or refetches when the
local day rolls over:

- **`resources/agendaData.ts`** — `agendaOccurrencesQuery` / `agendaRemindersQuery` key on
  `scope.dashboardId` only. The fetch window (`fetchAgendaOccurrences`, `today = startOfDay(new
  Date())`) and the today/overdue classification (`listItemToAgendaItem`, `todayKey`) are computed
  from `new Date()` at fetch time, so a cached agenda is frozen to the day it was fetched.
- **`components/dashboard/widgets/CalendarWidget.tsx:36`** — `today = useMemo(() =>
  startOfDay(new Date()), [])`, which drives both the occurrence window (→ the query key) and the
  "today" highlight / month-week grid.
- **`pages/CalendarPage.tsx:98`** — `today = useMemo(() => startOfDay(new Date()), [])`, plus inline
  `dateKey(new Date())` "is today" checks (`:316`, `:381`) that only re-evaluate on a re-render —
  which never happens on an idle page at midnight.

## Decision — one shared `useLocalDay()` hook; consumers refresh on rollover

Add a hook that yields the current local day and re-renders consumers when it changes; wire the
three consumers to it. For the agenda, refresh via **invalidation**, not by salting the cache key —
so no new cache entries accumulate.

### `useLocalDay()` — `frontend/src/hooks/useLocalDay.ts` (new)

Returns the local calendar day as a `'YYYY-MM-DD'` key.

- Schedules a `setTimeout` to the **next local midnight**, computed from local `Date` parts
  (`new Date(y, m, d + 1, 0, 0, 0, 0)`) each time — **DST-safe** (a 23- or 25-hour day is handled by
  the Date constructor; never a fixed `+24h`). Reschedules after each fire.
- Also re-syncs on `document` `visibilitychange`→visible and `window` `focus`, so a display that was
  asleep/backgrounded across midnight corrects on wake (a `setTimeout` does not reliably fire while
  the tab is asleep).
- Uses a functional `setState` that returns the previous value when the day is unchanged, so focus
  events on the same day cause **no** re-render.
- `+1s` guard on the scheduled delay so it can't fire a hair before midnight and read the old day.

### Consumers

1. **`CalendarWidget`** — `const dayKey = useLocalDay()`; `const today = useMemo(() =>
   startOfDay(new Date()), [dayKey])`. On rollover: fresh `today` → fresh `getWidgetWindow` →
   `useCalendarOccurrences` sees a new window key → refetch; the grid, highlight, and
   `visibleOccurrencesByDate` re-derive. (The new window entry is the *legitimate* window key — the
   same accumulation month-navigation already produces, tracked under #24; not new to this change.)

2. **`useAgendaItems`** (`resources/agendaData.ts`) — scope stays `{ dashboardId }` (one cache entry
   per dashboard, **bounded**). Add:

   ```ts
   const dayKey = useLocalDay()
   const previousDay = useRef(dayKey)
   useEffect(() => {
     if (previousDay.current === dayKey) return // skip mount; only act on a real rollover
     previousDay.current = dayKey
     if (!dashboardId) return
     agendaOccurrencesQuery.invalidateWhere((s) => s.dashboardId === dashboardId)
     agendaRemindersQuery.invalidateWhere((s) => s.dashboardId === dashboardId)
   }, [dayKey, dashboardId])
   ```

   At rollover the two agenda queries for this dashboard are marked stale and the mounted widget
   refetches (default `activeOnly`), recomputing window + today/overdue from a fresh `new Date()`.
   No cache key is salted, so **no new entries accumulate**.

3. **`CalendarPage`** — `const dayKey = useLocalDay()`; `const today = useMemo(() =>
   startOfDay(new Date()), [dayKey])`. Replace the inline `dateKey(new Date())` at `:316` and `:381`
   with `dateKey(today)` so the "is today" highlight tracks the day-aware value and re-renders at
   midnight. `monthCursor` / `selectedDate` stay user-navigable state (unchanged).

## Why invalidation for agenda, key-salting rejected

Salting the agenda scope with `dayKey` (`{dashboardId, dayKey}`) would also work, but it mints a new
cache entry every day that never evicts (scopedQuery has no gc — #24), which is ironic growth on the
exact always-on use case #12 targets. Invalidation is the mechanism the cache already has for "data
is stale, refetch," keeps exactly one entry per dashboard, and is semantically honest.

## Testing (Vitest, `jsdom`)

**`useLocalDay` (`src/hooks/useLocalDay.test.tsx`)** with `vi.useFakeTimers()` + `vi.setSystemTime`:
- rolls the returned key when the clock crosses local midnight (set time to 23:59, advance past
  00:00, assert the key advanced);
- re-syncs on `visibilitychange`→visible after the system date is moved forward (simulating a
  slept-through midnight);
- returns a stable key (no update) when a focus event fires on the same day.

**Agenda (`src/resources/agendaData.test.ts` or a small hook test)**: rendering `useAgendaItems`
across a `useLocalDay` rollover triggers a refetch (spy on `apiListOccurrences` /
`loadDashboardListDetails`, or on `invalidateWhere`), and does **not** on the initial mount.

## Out of scope

- `scopedQuery` garbage collection / the calendar window-entry accumulation — tracked under #24.
- Server-side windowing changes (#16) — unrelated.

## Execution

Two tasks: Task 1 = `useLocalDay` hook + its tests; Task 2 = wire the three consumers +
agenda-refetch test. Batched into the Phase 3 whole-branch review, which closes the phase.
