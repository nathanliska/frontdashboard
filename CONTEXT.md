# FrontDashboard — Working Context

## Completed Phase
**All 19 steps complete**

## Implementation Order (from PLAN.md §13)
- [x] 1. Repository + git setup
- [x] 2. Project scaffolding (Docker Compose, Caddy, FastAPI hello world, Vite hello world, .env.example)
- [x] 3. Database + migrations (Alembic, initial schema)
- [x] 4. Auth (registration, login, JWT cookies, refresh, CSRF, rate limiting)
- [x] 5. Group management (create group, invites, join/leave, roles)
- [x] 6. Permissions service
- [x] 7. Sidebar layout
- [x] 8. Lists module (backend)
- [x] 9. Lists module (frontend)
- [x] 10. Activity events
- [x] 11. SSE infrastructure
- [x] 12. Real-time list sync
- [x] 13. Notifications
- [x] 14. Dashboard system
- [x] 15. Private dashboard (revised — see design note above)
- [x] 16. Group dashboards page (merged into unified dashboard listing in Step 15)
- [x] 17. List widget
- [x] 18. Additional widgets (clock, welcome/status)
- [x] 19. Polish

## Step 15 Checklist
- [x] Migration `h6i9k7e3l1f8`: add `name`, `is_favorite`; drop both partial unique indexes
- [x] `Dashboard` model updated; removed `Dashboard` import from `groups.py`
- [x] Group dashboard no longer auto-created on group creation
- [x] `DashboardCreate` accepts optional `group_id` (private or group-shared)
- [x] `DashboardSummary` schema for listing; `DashboardUpdate` for rename/favorite
- [x] New router endpoints: `GET /api/dashboards`, `POST /api/dashboards`, `PATCH /{id}`, `DELETE /{id}`, `GET /{id}`
- [x] `api/dashboards.ts` — full CRUD + list
- [x] `stores/dashboard.ts` — summaries listing + active editor state
- [x] `DashboardsPage` — card grid, favorites section, create modal with scope picker
- [x] `DashboardEditorPage` — individual dashboard with back button
- [x] Routes: `/` and `/dashboards` → listing; `/dashboard/:id` → editor
- [x] Sidebar nav updated: "Dashboards" → `/dashboards`; removed separate Groups Dashboards entry

## Step 14 Checklist
- [x] `DashboardWidget` ORM model added to `dashboard.py`
- [x] Alembic migration `g5h8j6d2k0e7_add_dashboard_widgets`
- [x] `schemas/dashboards.py` — `DashboardResponse`, `WidgetResponse`, `LayoutUpdate`, `WidgetCreate`, `WidgetConfigUpdate`
- [x] `routers/dashboards.py` — GET private/group, PUT layout (version conflict → 409), POST/PATCH/DELETE widgets
- [x] Private dashboard auto-created on register (already in place); group dashboard on group creation (already in place)
- [x] Dashboard router registered in `main.py`
- [x] `react-grid-layout` added to `package.json` (run `npm install`)
- [x] `api/dashboards.ts` — all API calls
- [x] `stores/dashboard.ts` — Zustand store with conflict state
- [x] `components/dashboard/WidgetContainer.tsx` — drag handle, remove button
- [x] `components/dashboard/DashboardGrid.tsx` — WidthProvider + debounced layout save
- [x] `components/dashboard/AddWidgetModal.tsx` — widget type picker
- [x] `DashboardPage.tsx` — grid + conflict banner + add widget modal

## Dashboard Design Revision (diverges from PLAN.md)

Original PLAN.md had one auto-created private dashboard per user and one per group.
**Revised design:**
- Multiple dashboards per user and per group; both partial unique indexes dropped
- One default "My Dashboard" auto-created on user registration as a starting point
- **No** group dashboard auto-created on group creation — groups create them manually
- Dashboard listing page (`/dashboards`): shows personal + group dashboards, create button, favorites section
- Navigate to `/dashboard/:id` to view/edit a specific dashboard
- **On creation**: user picks private or shared (and which group for shared)
- **Scope change** (private↔shared): planned future feature — not yet implemented
- `dashboards` table additions: `name VARCHAR(100)`, `is_favorite BOOL`

## Step 17 Checklist
- [x] `ListWidget.tsx` — check/uncheck, add item, progress bar, size-aware (ResizeObserver), soft-fail on deleted list
- [x] `WidgetRenderer.tsx` — dispatches by `widget_type`; routes `list` → `ListWidget`, others → placeholder
- [x] `WidgetContainer.tsx` — now uses `WidgetRenderer` instead of type label placeholder
- [x] `AddWidgetModal.tsx` — two-step flow: pick type → for `list`, pick specific list; passes `resource_type`/`resource_id`
- [x] `DashboardEditorPage.tsx` — updated to pass full `AddWidgetParams`

## Step 18 Checklist
- [x] `ClockWidget.tsx` — live ticking time + date, size-aware (hides seconds + date when tiny)
- [x] `WelcomeWidget.tsx` — time-of-day greeting + user first name + date
- [x] `WidgetRenderer.tsx` — clock and welcome registered; switch-case dispatch

## Step 19 Checklist
- [x] Security headers middleware (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) on all responses
- [x] Toast system: `stores/toast.ts` + `components/ui/Toaster.tsx` (auto-dismiss 4s, manual dismiss, success/error/info types)
- [x] Confirm dialog: `stores/confirm.ts` + `components/ui/ConfirmDialog.tsx` (promise-based `await confirm(msg)`, usable from anywhere)
- [x] `AppShell` mounts `<Toaster>` + `<ConfirmDialog>` globally
- [x] `stores/dashboard.ts` + `stores/lists.ts` — all async actions wrapped in try/catch with `toast.error()`
- [x] `WidgetContainer`: widget header shows meaningful labels (`list_name` from config, "Clock", "Welcome")
- [x] `DashboardEditorPage`: `loadError` state shows "not found / no access" message with back link
- [x] Delete dashboard, remove widget: guarded with `await confirm(...)` before executing
- [x] `ListsPage`: auto-opens list on mount when navigated from a widget deep-link (`location.state.openListId`)
- [x] `stores/toast.ts` — added architecture comments explaining hook vs. `getState()` usage pattern

## Current Phase
**All 19 steps complete**

## Open Questions / Decisions Pending
- None currently
