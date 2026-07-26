# FDR-003: Widgets

**Status:** Active
**Last reviewed:** 2026-07-26

## Overview

Widgets are the tiles inside a dashboard grid. There are four types — **list**, **clock**,
**calendar**, and **agenda** — added through a wizard and rendered by type. This FDR covers what each
widget does and how a widget binds to (or creates) a resource. The grid and layout mechanics are
[FDR-002](FDR-002-dashboards-and-layout.md).

## Behavior

- **Add-widget wizard.** Pick a type, then — for types that bind a resource — pick or create the
  resource it shows.
- **List widget.** Shows a list; on add, bind an existing list or auto-create a new one. Deliberately
  **not** drag-reorderable inside the grid (its own drag would fight react-grid-layout's).
- **Clock widget.** Shows the current time. No bound resource.
- **Calendar widget.** Shows a calendar view of events. Re-derives "today" at local midnight so an
  always-on display doesn't stick on yesterday.
- **Agenda widget.** Shows today / overdue / upcoming items; background-refetches on a day rollover.
  Its reminders come from `GET /lists/details` — one dashboard-scoped batch of every list with its
  items — rather than composing summaries plus one detail request per list client-side (#17, closed
  2026-07-26). The batch fetcher reads no client cache, so SSE handler order is not load-bearing.
- Widgets update live: a change to the underlying list or calendar patches the widget in place via
  SSE rather than requiring a manual refresh.

## Design Decisions

### 1. Four fixed widget types, bound to resources where relevant

**Decision:** `WidgetType` is `'calendar' | 'agenda' | 'list' | 'clock'`. List/calendar/agenda bind a
resource; clock doesn't.
**Why:** A small, explicit set keeps the add-wizard, renderer, and resource wiring tractable.
**Tradeoff:** Adding a type is a cross-cutting change — it touches the `WidgetType` union, the
`WidgetRenderer` switch, the add-widget type step (plus a picker step if it binds a resource), and
the resource fetch/SSE wiring.

### 2. List widget can bind-or-create on add

**Decision:** Adding a list widget either binds an existing list or auto-creates one.
**Why:** Removes a two-step "make the list first, then add the widget" dance for the common case of a
fresh list.
**Tradeoff:** Two code paths (bind vs. create) in the add flow.

### 3. Day-dependent widgets refresh at local midnight

**Decision:** Calendar and agenda widgets re-derive "today" from a shared `useLocalDay()` hook that
ticks at the next local midnight (DST-safe) and on tab wake.
**Why:** FrontDashboard is built for always-on wall displays; without this, a widget shows
yesterday's agenda after midnight until manually refreshed. See [FDR-006](FDR-006-calendar-and-events.md).
**Tradeoff:** Day-dependent widgets carry a time-tick dependency instead of being purely data-driven.

### 4. List widget is intentionally not reorderable

**Decision:** The dashboard `ListWidget` does not support drag-reorder of its items.
**Why:** It lives inside react-grid-layout, whose own drag gesture would conflict with an
item-reorder drag. Reordering is available in the full Lists UI instead. See
[FDR-005](FDR-005-lists.md).
**Tradeoff:** Item reorder isn't available from the dashboard tile.

## Access

Widgets inherit the access of the dashboard that contains them and the resource they bind. Editors
can add/remove widgets; viewers see them read-only. See [FDR-004](FDR-004-sharing-and-access.md).

## Related

- **ADRs:** ADR-006 (REST fetch + SSE patch), ADR-001 (per-resource sharing)
- **FDRs:** FDR-002 (Dashboards & Layout), FDR-005 (Lists), FDR-006 (Calendar & Events)
