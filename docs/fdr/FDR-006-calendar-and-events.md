# FDR-006: Calendar & Events

**Status:** Active
**Last reviewed:** 2026-08-14

## Overview

The shared household calendar: create events, view them by day/week/month, handle weekly recurrence
with per-occurrence overrides, and keep day-dependent views correct on an always-on display. Events
are surfaced on dashboards via the calendar and agenda widgets ([FDR-003](FDR-003-widgets.md)).

## Behavior

- **Views.** Day, week, and month.
- **Event editor.** An editor with an all-day toggle, a duration toolbar, timezones and weekly
  recurrence, presented as a bottom sheet on a phone and a centred panel on a wider screen. It is a
  real dialog: Escape closes it, Tab stays within it, the page behind neither scrolls nor reaches
  assistive technology, and focus opens in the title field rather than on Cancel.
- **Duration is the end time, said another way.** The toolbar shows the gap between start and end in
  minutes, hours or days; typing a duration or stepping it moves the end time, and moving the start
  carries the duration with it. Switching the *unit* only changes how that gap reads — 90 minutes
  becomes 1.5 hours — because asking to see a duration differently is not an edit. While a value is
  being typed the field holds what was typed, including the empty and trailing-dot states a decimal
  passes through, and falls back to the event's real duration if what is left behind is unusable.
- **All-day means whole local days.** The editor takes a start and end date (shown inclusive —
  "ends on the 16th" — while the stored end stays exclusive), and toggling a timed event to
  all-day keeps the days it covered. Setting `all_day` snaps `starts_at` to local midnight and
  `ends_at` to local midnight after the last covered day, in the event's *own* timezone, so a day
  that runs 23 or 25 hours across a DST boundary is still exactly one day. The end is **exclusive**.
  The flag used to be a passthrough — whatever times the client sent were stored, which left
  "all-day" events starting at 09:00; they still appeared on the right days, but the agenda sorts by
  `starts_at` and so filed them among the timed events. Normalization is idempotent: re-saving an
  all-day event must not extend it, which is why the end steps back a microsecond before truncating.
- **Recurrence with overrides.** A recurring event expands into occurrences over a requested window
  (max 366 days); individual occurrences can be overridden or cancelled.
- **Midnight correctness.** Day-dependent views re-derive "today" at local midnight (DST-safe) and on
  tab wake, so an always-on wall display never shows yesterday's calendar/agenda after midnight.
- **Live updates.** Event create/update/delete and occurrence override/cancel propagate over SSE.
- **Participants.** An event can name dashboard members it is *about* — a visual label, not an
  invitation: no notification is sent and no access is granted or implied. Adding someone new
  requires current membership (422 otherwise); reads return participants with display names on
  events and on every expanded occurrence. A member who later loses dashboard access stays named
  on the event, and later edits may keep them — only newcomers are membership-checked.

## Design Decisions

### 1. Occurrences are expanded over a bounded window

**Decision:** Recurring events expand into occurrences over a required window capped at 366 days.
**Why:** A bounded window keeps expansion cost predictable and avoids unbounded/infinite recurrence
materialization; a year covers every realistic view.
**Tradeoff:** Callers must always pass a window, and views spanning more than a year need multiple
requests.

Which events are *loaded* for a window is a separate, SQL-level question (#16). One-off events are
bounded by their own times. Recurring ones are bounded by two facts already on the row — a series
yields nothing before its `starts_at`, and a rule carrying `until` yields nothing after
`until + duration` — both read from the row and the JSONB rule directly. **A denormalized
"last occurrence" column was considered and rejected**: it would have to be recomputed whenever
`starts_at`, `ends_at`, `timezone` or `recurrence` changes, and a single missed recomputation makes
events silently vanish from the calendar. Series with a `count` limit and no `until` therefore still
load unbounded — finding their end means expanding the rule, which is the work the predicate exists
to avoid.

### 2. Per-occurrence overrides and cancellations, not series edits only

**Decision:** A single occurrence can be overridden or cancelled independently of its series
(`calendar_event_overrides`; `calendar.event.occurrence.updated` / `...cancelled` events).
**Why:** Real household events need "move just this week's occurrence" without detaching the series.
**Tradeoff:** Read/expansion must reconcile the base series with its overrides. The database enforces
what it can — one override per `(event, occurrence_start)`, and `ends_at > starts_at` when an
override retimes an occurrence — but **that `occurrence_start` names a real instance of the parent's
recurrence rule cannot be a CHECK**, since deciding it requires expanding the RRULE. That invariant
is application-level by nature, not by omission, so an override written directly to the database
can point at an occurrence that does not exist.

Expansion reconciles in **both** directions, which is easy to get wrong in one. Overrides are keyed
by the occurrence's *original* start, and the expander walks the requested window rather than the
whole series — so an override that retimes an occurrence into the window from a date outside it has
no generated start to attach to. Those overrides are collected explicitly (`services/calendar.py`),
or "move next Tuesday's meeting to next month" would disappear from every window that did not also
contain the date it came from. This is also what makes the window predicate's deliberately
unbounded `has_override` clause mean something rather than load rows the expander discards.

### 3. Day-dependent views refresh at local midnight via `useLocalDay()`

**Decision:** A shared `useLocalDay()` hook re-renders at the next local midnight and on
visibility/focus; the calendar widget and page re-derive "today" from it, and the agenda derives its
window from it — so the occurrence store reloads on rollover on its own, while reminders, which
classify overdue/today at fetch time, still background-refetch explicitly.
**Why:** The app targets always-on wall displays, where a naive "today" computed once at mount goes
stale overnight. See CONTEXT.md.
**Tradeoff:** Day-dependent UI carries a time-tick dependency; midnight/DST edge cases need care.

### 4. Occurrences are cached by covered interval, not by request window

**Decision:** One occurrence store per dashboard records which time ranges it has loaded and fetches
only the gaps; every reader — calendar page, calendar widget, agenda widget — subscribes to it and
filters to its own window. Windows requested in the same tick are coalesced into one span.
**Why:** A cache keyed on the request window makes two overlapping windows two unrelated entries, so
the same days were fetched two or three times per mount — measured at 723 of 730 days redundant
between the agenda's `today → today+8` and the widget's 42-day grid, which contains it structurally
because the widget cannot be paged.
**Tradeoff:** Readers no longer own their data, so invalidation has to know which windows are on
screen — mounted windows are registered as well as fetched, or an SSE event would clear coverage
that nothing reloads. Retained coverage is capped at 366 days (the backend's own window ceiling),
dropping ranges furthest from what is displayed.

### 5. Deleting an event is undoable

**Decision:** `CalendarEvent` carries `deleted_at`, filtered in every query, and the deletion toast
offers Restore — a real restore, so recurrence, per-occurrence overrides and participants come back
with the event rather than being retyped.
**Why:** An event is expensive to reconstruct by hand, which is the test for recoverability in
[ADR-007](../adr/ADR-007-soft-delete-boundary.md). There is no event trash: the failure worth
protecting against is a misclick, and undo answers that where a listing would be ceremony.
**Tradeoff:** Every event query must filter the tombstone. Once the toast is gone the event is only
recoverable by someone who kept its id, and it keeps occupying the owner's quota until the reaper
purges it ([ADR-020](../adr/ADR-020-resource-quotas.md)).

Restore takes edit access on the parent dashboard, so a viewer cannot undo someone else's delete,
and an event whose dashboard is itself trashed cannot be restored alone — restore the dashboard.

### 6. Participants are series-level labels, validated against membership at write time

**Decision:** One participant set per event, never per-occurrence; rows cascade with the event.
A *newcomer* to the set must be a current dashboard member ([FDR-004](FDR-004-sharing-and-access.md));
ids already on the event stay legal even after an unshare, so an edit never forces dropping a
departed member, and readers render them from the user row.
**Why:** "Whose thing is this" rarely varies by week, and revoking access should not silently
rewrite what past or future events say about who they are for. Access continues to flow from the
dashboard alone — a participant row grants nothing.
**Tradeoff:** Naming one occurrence's stand-in needs a separate mechanism if it is ever wanted,
and the picker must distinguish current members (from `/members`) from former ones (named only on
the event).

Creating an event is refused once the creator holds the configured ceiling, or once the dashboard
does. Trashed events count until the reaper purges them ([ADR-020](../adr/ADR-020-resource-quotas.md));
editing and deleting are never gated.

## Access

Events inherit access from the dashboard whose widget binds them (owner / editor / viewer). Their own
`/shares` endpoints are 409 stubs. See [FDR-004](FDR-004-sharing-and-access.md).

## Open Questions

- **Reminders are unbuilt, and the schema for them is kept on purpose (decided 2026-07-25).** The
  `CalendarReminder` table — `calendar_event_id` + `minutes_before`, cascading on event delete — has
  no router, service or reader, and nothing has ever written a row to it. It is reserved for a
  future "notify me N minutes before" feature, not leftover from a removed one, so leave it in place
  rather than re-flagging it as dead code. Building it needs a scheduler, notification delivery,
  per-user opt-in and timezone handling — none of which exist. Its `minutes_before` CHECK constraint
  (#30) lands with the feature, not before.
- Not to be confused with the agenda widget's **list reminders**, which are list items carrying a due
  date and have nothing to do with this table. See [FDR-005](FDR-005-lists.md).

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-007 (the delete boundary), ADR-015 (SSE write choreography),
  ADR-020 (resource quotas)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
