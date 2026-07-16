# backend/CLAUDE.md — conventions that bite

Stack-specific memory for the FastAPI backend. Repo-wide rules live in the root `CLAUDE.md`.
Everything here is a convention an agent can't safely infer from one file.

## Security & permissions
- **Every non-GET route must add `_csrf: None = Depends(require_csrf)`.** CSRF is a dependency,
  not middleware — omit it and the endpoint silently accepts cross-site requests.
- **`role is None` means owner, not "no access".** `permissions.effective_role` returns `None`
  for the creator and raises 404 for no access; never write `if role:` guards
  (`app/services/permissions.py`).
- Child resources (lists, events) get access via `load_dashboard_access` /
  `list_accessible_dashboard_ids` (`app/services/shares.py`), which silently filter archived
  dashboards — querying the child table directly breaks the archived-visibility invariant.
- List/calendar `/shares` endpoints are **deliberate 409 stubs** — sharing is dashboard-managed
  and inherited. Don't "implement" them.

## Mutation choreography (every mutating route)
- Soft-delete is per-table and manual: `User`/`List`/`ListItem`/`CalendarEvent` have
  `deleted_at` (filter it in every query); `Dashboard`/`DashboardWidget` are **hard-deleted**.
- `log_event(...)` and `stage_notification(...)` only `db.add` — the route owns the single
  commit so events land in the same transaction as the mutation.
- **SSE ordering is load-bearing:** build the event dict (`app/sse/events.py` — flush/refresh)
  *before* commit; `manager.broadcast(...)` *after* commit. Broadcast to
  `{dashboard.user_id} ∪ share principal_ids` or other users' open tabs silently go stale.
- Layout/widget writes need the dashboard row lock (`lock_for_update=True`) **and** a
  `dashboard.version` bump; `PUT /layout` compares client vs. server version (409 on mismatch).
- JWT embeds `email`, so any route mutating identity fields must re-issue the access cookie
  (`_set_access_cookie`) — profile and password-change already do.

## Migrations & models
- Alembic revisions are hand-authored 12-char slugs with explicit `down_revision` chaining —
  match the style. Role/type enums are stored as plain `String` (StrEnum), not PG enums.
- **A new model module must be imported in BOTH `alembic/env.py` and `tests/conftest.py`** or
  it's invisible to autogenerate and to test table creation.

## Tests & email
- pytest uses Testcontainers (`postgres:16-alpine`, needs Docker). Schema comes from
  `Base.metadata.create_all` — **migrations are never exercised by tests**, so Alembic drift
  won't be caught there. Each test runs in a rolled-back savepoint.
- Tests monkeypatch email senders by the *router's* import path
  (`app.routers.auth.send_verification_email`) — import/call them that way. With
  `resend_api_key` unset the sender logs the link instead of sending (the only way to get a
  token locally). Emails go through `BackgroundTasks`, always queued after `db.commit()`.
