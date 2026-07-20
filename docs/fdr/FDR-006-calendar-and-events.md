# FDR-006: Calendar & Events

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

The shared household calendar: create events, view them by day/week/month, handle weekly recurrence
with per-occurrence overrides, and keep day-dependent views correct on an always-on display. Events
are surfaced on dashboards via the calendar and agenda widgets ([FDR-003](FDR-003-widgets.md)).

## Behavior

- **Views.** Day, week, and month.
- **Event editor.** A mobile-optimized editor with all-day toggle, a duration toolbar, timezones, and
  weekly recurrence.
- **Recurrence with overrides.** A recurring event expands into occurrences over a requested window
  (max 366 days); individual occurrences can be overridden or cancelled.
- **Midnight correctness.** Day-dependent views re-derive "today" at local midnight (DST-safe) and on
  tab wake, so an always-on wall display never shows yesterday's calendar/agenda after midnight.
- **Live updates.** Event create/update/delete and occurrence override/cancel propagate over SSE.

## Design Decisions

### 1. Occurrences are expanded over a bounded window

**Decision:** Recurring events expand into occurrences over a required window capped at 366 days.
**Why:** A bounded window keeps expansion cost predictable and avoids unbounded/infinite recurrence
materialization; a year covers every realistic view.
**Tradeoff:** Callers must always pass a window, and views spanning more than a year need multiple
requests.

### 2. Per-occurrence overrides and cancellations, not series edits only

**Decision:** A single occurrence can be overridden or cancelled independently of its series
(`calendar_event_overrides`; `calendar.event.occurrence.updated` / `...cancelled` events).
**Why:** Real household events need "move just this week's occurrence" without detaching the series.
**Tradeoff:** Read/expansion must reconcile the base series with its overrides.

### 3. Day-dependent views refresh at local midnight via `useLocalDay()`

**Decision:** A shared `useLocalDay()` hook re-renders at the next local midnight and on
visibility/focus; the calendar widget and page re-derive "today" from it, and the agenda widget
background-refetches on a day rollover.
**Why:** The app targets always-on wall displays, where a naive "today" computed once at mount goes
stale overnight. See CONTEXT.md.
**Tradeoff:** Day-dependent UI carries a time-tick dependency; midnight/DST edge cases need care.

### 4. Everything is soft-deleted

**Decision:** `CalendarEvent` carries `deleted_at`, filtered in every query.
**Why:** Calendar entries are durable user data worth a recovery path. See ADR-007.
**Tradeoff:** Every event query must filter the tombstone.

## Access

Events inherit access from the dashboard whose widget binds them (owner / editor / viewer). Their own
`/shares` endpoints are 409 stubs. See [FDR-004](FDR-004-sharing-and-access.md).

## Open Questions

- The `CalendarReminder` model/table exists with no router/service usage — vestigial, awaiting a
  decision when calendar work resumes (CONTEXT.md "Deliberately deferred").

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-007 (soft delete), ADR-015 (SSE write choreography)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
