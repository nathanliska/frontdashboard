# Midnight Invalidation (#12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time-dependent dashboard data (agenda, calendar widget, calendar page) refreshes when the local calendar day rolls over, so an always-on display never shows yesterday.

**Architecture:** One shared `useLocalDay()` hook re-renders consumers at local midnight (and on wake); the calendar widget/page re-derive `today` from it, and the agenda invalidates its cache on rollover (no new cache entries). See `docs/designs/dashboard-midnight-invalidation-design.md`.

**Tech Stack:** React 19 + TypeScript, custom `scopedQuery` cache, Vitest (`jsdom` for these).

## Global Constraints

- DST-safe: compute the next midnight from local `Date` parts, never a fixed `+24h`.
- Agenda refresh is by **invalidation**, not by adding `dayKey` to the cache scope — no new entries per day.
- Do not touch `scopedQuery` gc or the calendar window-entry accumulation (#24).
- `useLocalDay` must not re-render consumers when the day is unchanged (functional `setState` bailout).
- Conventional Commit messages, no attribution trailer. Confirm before committing.

---

### Task 1: `useLocalDay()` hook

**Files:**
- Create: `frontend/src/hooks/useLocalDay.ts`
- Test: `frontend/src/hooks/useLocalDay.test.tsx`

**Interfaces:**
- Produces: `useLocalDay(): string` — the current local day as `'YYYY-MM-DD'`.

- [ ] **Step 1: Write the failing tests** (`jsdom`, `vi.useFakeTimers()` + `vi.setSystemTime`)

Cover: (a) the key advances when the clock crosses local midnight; (b) it re-syncs on a
`visibilitychange`→visible event after the system date moved forward; (c) a `focus` event on the
same day yields no change (stable key, and ideally no extra render). Render the hook via a small
test component or `@testing-library/react`'s `renderHook`.

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/hooks/useLocalDay.test.tsx` → FAIL (module does not exist yet).

- [ ] **Step 3: Implement the hook**

```ts
import { useEffect, useState } from 'react'
import { dateKey, startOfDay } from '../utils/calendar/calendarUtils'

function currentDayKey(): string {
  return dateKey(startOfDay(new Date()))
}

function msUntilNextMidnight(): number {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return next.getTime() - now.getTime()
}

/**
 * The current local calendar day as a 'YYYY-MM-DD' key. Re-renders consumers when the day rolls
 * over — at local midnight (DST-safe: the next midnight is recomputed from local Date parts, never
 * by adding 24h) and whenever a backgrounded tab becomes visible again (a display that slept
 * through midnight). Lets always-on dashboards refresh day-dependent data instead of showing
 * yesterday indefinitely.
 */
export function useLocalDay(): string {
  const [day, setDay] = useState(currentDayKey)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>

    const sync = () => {
      setDay((prev) => {
        const next = currentDayKey()
        return next === prev ? prev : next
      })
    }

    const schedule = () => {
      timer = setTimeout(() => {
        sync()
        schedule()
      }, msUntilNextMidnight() + 1000)
    }
    schedule()

    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', sync)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', sync)
    }
  }, [])

  return day
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- src/hooks/useLocalDay.test.tsx` → pass. `npx tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useLocalDay.ts frontend/src/hooks/useLocalDay.test.tsx
git commit -m "feat(dashboards): add useLocalDay hook that ticks at local midnight (#12)"
```

---

### Task 2: Wire the three consumers

**Files:**
- Modify: `frontend/src/resources/agendaData.ts` (`useAgendaItems` — add rollover invalidation)
- Modify: `frontend/src/components/dashboard/widgets/CalendarWidget.tsx` (`today` derives from `useLocalDay`)
- Modify: `frontend/src/pages/CalendarPage.tsx` (`today` derives from `useLocalDay`; inline `dateKey(new Date())` → `dateKey(today)`)
- Test: `frontend/src/resources/agendaData.test.ts` (rollover triggers refetch; mount does not)

**Interfaces:**
- Consumes: `useLocalDay()` from Task 1; existing `agendaOccurrencesQuery` / `agendaRemindersQuery` module singletons and their `invalidateWhere`.

- [ ] **Step 1: Write the failing agenda test**

Render `useAgendaItems(dashboardId)` (via `renderHook` or a wrapper). Mock `apiListOccurrences` and
`loadDashboardListDetails` (or spy on the queries' `invalidateWhere`). Assert: no invalidation/extra
fetch on initial mount; after advancing `useLocalDay` across midnight (`vi.setSystemTime` +
`vi.advanceTimersByTime`), the two agenda queries refetch for that dashboard.

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- src/resources/agendaData.test.ts` → the rollover-refetch assertion FAILS (today the cache is keyed on `dashboardId` only and never refetches on a day change).

- [ ] **Step 3: Add rollover invalidation to `useAgendaItems`**

Add `useLocalDay` + a ref-guarded effect (skip mount, invalidate this dashboard's agenda queries on a real day change). Import `useEffect`, `useRef` (extend the existing `useMemo` import) and `useLocalDay`. Scope stays `{ dashboardId }`.

```ts
  const dayKey = useLocalDay()
  const previousDay = useRef(dayKey)
  useEffect(() => {
    if (previousDay.current === dayKey) return
    previousDay.current = dayKey
    if (!dashboardId) return
    agendaOccurrencesQuery.invalidateWhere((s) => s.dashboardId === dashboardId)
    agendaRemindersQuery.invalidateWhere((s) => s.dashboardId === dashboardId)
  }, [dayKey, dashboardId])
```

- [ ] **Step 4: Wire `CalendarWidget`**

Replace `const today = useMemo(() => startOfDay(new Date()), [])` with:

```ts
  const dayKey = useLocalDay()
  const today = useMemo(() => startOfDay(new Date()), [dayKey])
```

(add the `useLocalDay` import.)

- [ ] **Step 5: Wire `CalendarPage`**

Replace `const today = useMemo(() => startOfDay(new Date()), [])` with the `dayKey`-dependent form
(as above), and change the two inline `dateKey(new Date())` "is today" checks (`:316`, `:381`) to
`dateKey(today)`. (add the `useLocalDay` import.)

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npm test -- src/resources/agendaData.test.ts` → pass. `npx tsc -b` → clean. `npm run lint` → clean.
Run the full `npm run test:run` to confirm no calendar/agenda regressions.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/resources/agendaData.ts frontend/src/resources/agendaData.test.ts frontend/src/components/dashboard/widgets/CalendarWidget.tsx frontend/src/pages/CalendarPage.tsx
git commit -m "fix(dashboards): refresh agenda and calendar at local midnight (#12)"
```

---

## Self-Review

- **Spec coverage:** `useLocalDay` + tests = Task 1; the three consumers + agenda refetch test = Task 2. DST-safety and the no-render-on-same-day bailout are in the hook (Task 1 Step 3) and asserted (Step 1c).
- **Placeholder scan:** hook code literal; the two test files are described by behavior to match existing test conventions (fake timers, `renderHook`, module mocks).
- **Bounded growth:** agenda uses invalidation with an unchanged `{ dashboardId }` scope — no per-day entries. The calendar window entry per day is the pre-existing #24 accumulation, unchanged here.
