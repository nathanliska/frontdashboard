# FDR-002: Dashboards & Layout Editor

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

Dashboards are the top-level surface: a user has multiple, each a grid of widgets they arrange. This
FDR covers the dashboard lifecycle (create, favorite, archive, delete), the grid layout editor, and
how concurrent and mobile edits are kept safe. Widgets themselves are [FDR-003](FDR-003-widgets.md);
sharing is [FDR-004](FDR-004-sharing-and-access.md).

## Behavior

- **Multiple dashboards per user.** A default "My Dashboard" is created at registration. A listing
  page shows all of them with favorites, a create modal, and archive state.
- **Favorites and home.** Dashboards can be favorited; a user picks a home dashboard in their profile.
- **Archive.** A dashboard can be archived (shown with a badge, in its own section, with an editor
  banner) rather than deleted. Archived dashboards are filtered out of child-resource access.
- **Delete is hard and cascading.** Deleting a dashboard also removes its owned lists, items, events,
  widgets, and shares.
- **Editor.** Drag/resize widgets on a react-grid-layout grid; changes save automatically. A
  conflicting concurrent save shows a banner and reloads rather than clobbering.
- **Mobile is read-only stacking.** Below 640px the grid renders as a computed single-column stack;
  it never writes a layout back.
- **Settings modal.** Rename, archive, and share from a per-dashboard settings modal.
- **Mutations preserve user input on failure.** A failed create/rename/widget-add/share-add keeps
  what the user typed instead of discarding it.

## Design Decisions

### 1. Layout concurrency uses a version integer (OCC)

**Decision:** Each dashboard has a `version` integer; `PUT /layout` compares client vs. server
version and returns 409 on mismatch, surfaced as a banner (never thrown).
**Why:** Detects a genuine two-editor conflict without pessimistically locking the whole editing
session. See ADR-008.
**Tradeoff:** Conflicts resolve by reloading the winner's layout, not by merging.

### 2. Rapid saves are serialized and coalesced

**Decision:** One layout PUT is in flight at a time plus one latest-pending layout, each send
re-reading the version the previous save returned.
**Why:** Rapid drag/resize would otherwise conflict with itself or install an older layout; this
makes every 409 a *real* other-editor conflict. See ADR-008.
**Tradeoff:** Hand-rolled in-flight/serial machinery in the store that must be maintained carefully.

### 3. Persisted layout is canonical; mobile is a derived projection

**Decision:** The stored layout is the source of truth; the mobile single-column view is computed
from it and ignores layout events, as do read-only dashboards.
**Why:** Stops a phone (or a viewer) from flattening and persisting over the desktop arrangement. See
ADR-009.
**Tradeoff:** No independently editable mobile layout; that would need a per-breakpoint persisted
layout, deliberately not built.

### 4. Dashboards are hard-deleted, with cascade

**Decision:** Dashboards and widgets are hard-deleted (no `deleted_at`); delete cascades to owned
lists/items/events/shares.
**Why:** A dashboard is disposable scaffolding, cheap to recreate; its durable *content* is
soft-deleted separately. See ADR-007.
**Tradeoff:** No dashboard undo; the cascade must be maintained explicitly.

### 5. All dashboard mutations share one success/failure contract

**Decision:** Store actions never throw — value-producers resolve `T | null`, void ones resolve
`boolean`, and the store owns the error toast. Dialogs close, inputs clear, and navigation happen
only on a truthy result.
**Why:** Makes failure handling uniform and keeps a user's input on error instead of discarding it.
**Tradeoff:** Callers must check the return value rather than rely on try/catch.

## Access

- **Owner** (creator): full control including delete and share.
- **Editor**: can edit the layout and bound resources.
- **Viewer**: read-only; the client emits no layout writes for viewers.

See [FDR-004](FDR-004-sharing-and-access.md) for how roles are granted.

## Related

- **ADRs:** ADR-007 (soft/hard delete boundary), ADR-008 (layout version OCC), ADR-009 (canonical
  layout / mobile projection), ADR-001 (per-resource sharing)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
