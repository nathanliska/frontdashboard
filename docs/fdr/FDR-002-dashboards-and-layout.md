# FDR-002: Dashboards & Layout Editor

**Status:** Active
**Last reviewed:** 2026-08-26

## Overview

Dashboards are the top-level surface: a user has multiple, each a grid of widgets they arrange. This
FDR covers the dashboard lifecycle (create, favorite, trash, restore), the grid layout editor, and
how concurrent edits and narrow windows are kept safe. Widgets themselves are [FDR-003](FDR-003-widgets.md);
sharing is [FDR-004](FDR-004-sharing-and-access.md).

## Behavior

- **Multiple dashboards per user.** A default "My Dashboard" is created at registration. A listing
  page shows all of them with favorites, a create modal, and a Trash view. Deleting one confirms
  first, then offers **Undo** on the toast — the trash remains the way back after that.
- **Favorites and home.** Dashboards can be favorited; a user picks a home dashboard in their profile.
- **Trash is the only put-away state.** There is no archive: a dashboard is either live or in the
  trash. Trashed dashboards are filtered out of every listing and out of child-resource access
  ([ADR-007](../adr/ADR-007-soft-delete-boundary.md)).
- **Delete is hard and cascading.** Deleting a dashboard also removes its owned lists, items, events,
  widgets, and shares.
- **Editor.** Drag/resize widgets on a react-grid-layout grid; changes save automatically. A
  conflicting concurrent save shows a banner and reloads rather than clobbering.
- **A narrow board is read-only stacking.** Below the width where a default widget stops being
  readable, the grid renders as a computed single-column stack; it never writes a layout back.
- **Settings modal.** Rename and share from a per-dashboard settings modal.
- **Mutations preserve user input on failure.** A failed create/rename/widget-add/share-add keeps
  what the user typed instead of discarding it.

## Design Decisions

### 1. Layout concurrency uses a version integer (OCC)

**Decision:** Each dashboard has a `version` integer; `PUT /layout` compares client vs. server
version and returns 409 on mismatch (never thrown). The client resolves the first 409 itself —
re-read the dashboard, replay the drag onto the server's layout, retry once — and only shows the
banner if that retry is beaten too.
**Why:** Detects a genuine two-editor conflict without pessimistically locking the whole editing
session. See ADR-008, which stands: the version still does its job, the user just no longer has to
resolve it by hand. The banner fired more widely than "two people dragging" suggests — widget add
and delete bump the version too, so another user adding a widget made your next drag conflict.
**Tradeoff:** The replay is a merge: the server's layout is the base and this client's items are
overlaid by widget id, because `PUT /layout` replaces the array wholesale and never checks it
against the widget set — posting our own stale array would strip a widget the other editor just
added. Two people dragging the *same* widget still means one of them loses, which is the right
answer for a position. A failed re-read falls back to the banner rather than retrying blind.
**The write also carries an optional `gesture`** — the widget a person moved or resized. It is the
one fact the saved layout destroys: compaction reflows neighbours, so a server-side diff names every
widget that shifted rather than the one that was grabbed, and only the client holds the difference.
The server records it solely when the id belongs to that dashboard, and every other layout write —
fitting a new widget, the mobile projection, a replayed merge — simply omits it.

### 2. Rapid saves are serialized and coalesced

**Decision:** One layout PUT is in flight at a time plus one latest-pending layout, each send
re-reading the version the previous save returned.
**Why:** Rapid drag/resize would otherwise conflict with itself or install an older layout; this
makes every 409 a *real* other-editor conflict. See ADR-008.
**Tradeoff:** Hand-rolled in-flight/serial machinery in the store that must be maintained carefully.

### 3. Persisted layout is canonical; the stacked view is a derived projection

**Decision:** The stored layout is the source of truth; the single-column view a narrow board falls
back to is computed from it and ignores layout events, as do read-only dashboards.
**Why:** Stops a narrow window (or a viewer) from flattening and persisting over the arrangement.
The trigger is a width, not a device — a split screen stacks like a phone. See ADR-009.
**Tradeoff:** No independently editable stacked layout; that would need a per-breakpoint persisted
layout, deliberately not built.

### 4. Deleting a dashboard moves it to the trash (#40, 2026-07-26)

**Decision:** DELETE stamps `deleted_at`: the dashboard vanishes from every listing and access
path (children included), sits in the owner's trash with a visible purge deadline, and is
restorable — shares and children intact — until the reaper purges it after 30 days
(`trash_retention_days`). Widgets alone remain hard-deleted.
**Why:** A dashboard is the access root for everything on it; the old immediate cascade meant one
misclick permanently destroyed content several people used. See ADR-007 (amended).
**Tradeoff:** Trashed rows must be filtered at every access/listing/inheritance site (same footgun
class as the old `archived` flag did), and the purge cascade runs in the reaper rather than the request path.

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

Creating a dashboard is refused once the owner holds the configured ceiling, and adding a widget
once the dashboard does. Trashed dashboards count until the reaper purges them
([ADR-020](../adr/ADR-020-resource-quotas.md)). The trash view offers **Delete permanently**
alongside Restore, which takes the dashboard and its cascade at once and asks first; it is the only
irreversible action there.

## Related

- **ADRs:** ADR-007 (soft/hard delete boundary), ADR-008 (layout version OCC), ADR-009 (canonical
  layout / stacked projection), ADR-001 (per-resource sharing), ADR-020 (resource quotas)
- **FDRs:** FDR-003 (Widgets), FDR-004 (Sharing & Access)
