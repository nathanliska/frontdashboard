# Design — Dashboard deletion honors soft-deleted children (#2)

**Date:** 2026-07-18
**Status:** ✅ Shipped 2026-07-18 (`264b24d`). Stays in `docs/designs/` until Phase 3 closes (its
whole-branch review is batched across slices A–D), then moves to `docs/shipped/` with the plan.
**Finding:** #2 (dashboard deletion does not honor all owned rows), Phase 3 (dashboard
correctness), 2026-07-11 review. First slice of Phase 3.

## Problem

`delete_dashboard` (`backend/app/routers/dashboards.py`) selects its child lists and calendar
events with `deleted_at IS NULL`, so any **soft-deleted** list or event is skipped and left in
place. Those rows still carry a `dashboard_id` foreign key to `dashboards.id`, and that FK has
**no `ON DELETE` behavior** (plain `NO ACTION`). So the handler's final
`DELETE FROM dashboards WHERE id = :id` raises `ForeignKeyViolation` → the request 500s.

This is reproducible any time a dashboard has *ever* had a list or event soft-deleted (archive a
list then delete it; delete a calendar event — both set `deleted_at` and leave the row): the
dashboard can then never be deleted through the API.

### Verified mechanism (in code)

- Only three tables FK `dashboards.id`: `dashboard_widgets` (**has** `ON DELETE CASCADE`,
  `app/models/dashboard.py:25`), `lists` (`app/models/list.py:43`, no ondelete), and
  `calendar_events` (`app/models/calendar.py:30`, no ondelete). Migration `q6s8u0w2y4a6:121,125`
  confirms the two child FKs were created without `ondelete`.
- `list_items` → `lists.id` also lacks cascade, but items are deleted **explicitly before** their
  lists in the handler, so they never block. `calendar_event_overrides` and `calendar_reminders`
  → `calendar_events.id` already cascade, so deleting an event removes them.
- Lists and calendar events inherit access from their dashboard — their `/shares` endpoints are
  409 stubs — so they never own `ResourceShare` rows; `cleanup_resource_shares` for a child is a
  no-op today and stays one for soft-deleted children too (harmless to call).

## Decision

**Application-level fix.** Delete every child list/event of the dashboard regardless of
soft-delete state, keeping the handler's existing cleanup choreography. Chosen over adding
`ON DELETE CASCADE` (the other option in the finding) because:

- It fixes the reproducible bug with the smallest change and no migration.
- Dashboard deletion already *deliberately* owns child cleanup — the handler's own comment says
  future dashboard-owned tables should be swept here by `dashboard_id`. App-managed cleanup is the
  established pattern, not a workaround.
- Tests build the schema from `Base.metadata.create_all` on the models, **not** migrations
  (`backend/CLAUDE.md`). A model-level cascade would make `create_all` tests pass while masking a
  mistake in the hand-written migration — exactly the #20 drift hazard. The app-level fix sidesteps
  the whole class.

## Change

In `delete_dashboard` (`backend/app/routers/dashboards.py`):

- Remove `List.deleted_at.is_(None)` from the child-list select. `list_ids` now includes
  soft-deleted lists; their items are already swept by the existing
  `delete(ListItem).where(ListItem.list_id.in_(list_ids))`, their shares cleaned (no-op), then the
  lists delete.
- Remove `CalendarEvent.deleted_at.is_(None)` from the child-event select. Soft-deleted events are
  now deleted too; their overrides/reminders cascade.

Nothing else moves: deletion order (items → lists, events, widgets, dashboard), per-child share
cleanup, `_remove_dashboard_from_user_preferences`, and the build-event-before-commit /
`broadcast`-after-commit ordering are all unchanged. No migration, no schema change.

### Why this is complete

Only `lists` and `calendar_events` FK `dashboards.id` without cascade; both are now swept
regardless of soft-delete state, so no child row can block the parent delete or be orphaned.

## Testing (pytest, Testcontainers)

One regression test in `backend/tests/test_dashboards.py` (uses `auth_client` + the `db_session`
fixture, which shares the request session so writes are visible to the route):

1. `create_dashboard`; `create_list` under it; add one item to the list via
   `POST /api/lists/{id}/items`; `create_calendar_event` under it.
2. Via `db_session`, set `deleted_at = datetime.now(UTC)` on the `List` row **and** the
   `CalendarEvent` row (direct soft-delete — cleaner than the archive→delete API dance, and it
   leaves the list's item in place so we prove items of a soft-deleted list are swept). Commit.
3. `DELETE /api/dashboards/{id}` → assert `204`. **This is RED before the fix**: `create_all`
   builds the same non-cascade FK, so the soft-deleted children make the parent delete raise
   `ForeignKeyViolation` and the request fails (not `204`).
4. Via `db_session`, assert no rows remain for the dashboard: `Dashboard`, the `List`, its
   `ListItem`, and the `CalendarEvent` are all gone.

Existing dashboard-delete tests
(`test_delete_archived_dashboard_removes_dashboard_owned_lists_and_events`,
`test_dashboard_calendar_routes_and_delete`, `test_delete_dashboard_clears_dashboard_preferences`)
must stay green — they cover the active-child path, which is unchanged.

## Out of scope

- `ON DELETE CASCADE` on the child FKs (defense-in-depth against future/direct deletes) —
  deliberately not taken; see Decision.
- The rest of Phase 3 (#9/#11 layout saves, #10 mutation contracts, #12 midnight invalidation) —
  separate specs.

## Execution

Single small task (one route edit + one test), TDD, followed by one task review and the Phase 3
whole-branch review when the phase closes.
