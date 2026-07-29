# backend/CLAUDE.md — conventions that bite

Stack-specific memory for the FastAPI backend. Repo-wide rules live in the root `CLAUDE.md`.
Everything here is a convention an agent can't safely infer from one file.

## Security & permissions
- **Every non-GET route must add `_csrf: None = Depends(require_csrf)`.** CSRF is a dependency,
  not middleware — omit it and the endpoint silently accepts cross-site requests. It runs two
  checks: `Origin` against the allowed origins (skipped when the header is absent, so it can never
  lock out a client on its own), then the double-submit cookie/header pair. The allowlist is
  `frontend_base_url` + `cors_origins_list` and is **not** branched on environment — a rule only
  production runs is a rule no test executes. The one cost: browsing the dev server by LAN address
  (Vite binds all interfaces) sends that address as `Origin`, so it must be in `CORS_ORIGINS` or
  every mutation 403s. Rejections log the origin.
- **Every non-GET route also needs `@limiter.limit(WRITE_LIMIT)` and a `request: Request`
  parameter.** slowapi resolves the decorator at import and needs that argument even though the
  handler never reads it. `test_rate_limit_coverage.py` fails the build if a mutating route has no
  limit, so this cannot be silently forgotten the way it was until 2026-07-29. It has to be per
  route: slowapi's application-wide limit runs in a middleware that resolves handlers through
  `app.routes`, which cannot see through this FastAPI version's included-router nesting, so it
  exempts everything (measured — 1260 requests, zero 429s). **Beware that same nesting when writing
  any audit over routes**: iterating `app.routes` reaches four docs routes and one `_IncludedRouter`,
  so an assertion over it passes having checked nothing.
- **`role is None` means owner, not "no access".** `permissions.effective_role` returns `None`
  for the creator and raises 404 for no access; never write `if role:` guards
  (`app/services/permissions.py`).
- Child resources (lists, events) get access via `load_dashboard_access` /
  `list_accessible_dashboard_ids` (`app/services/shares.py`), which silently filter trashed
  dashboards — querying the child table directly breaks the trashed-visibility invariant.
- List/calendar `/shares` endpoints are **deliberate 409 stubs** — sharing is dashboard-managed
  and inherited. Don't "implement" them. Since #19 the database agrees: CHECK constraints pin
  `resource_shares.resource_type` to `'dashboard'` and `principal_type` to `'user'`, which is what
  lets `resource_id` and `principal_id` carry real FKs. Writing a share for any other resource type
  is now an `IntegrityError`, not a row nobody reads.

## Mutation choreography (every mutating route)
- Soft-delete is per-table and manual: `User`/`List`/`ListItem`/`CalendarEvent` have
  `deleted_at` (filter it in every query). **`User.deleted_at` is the exception that is filtered but
  never set** — there is no account-deletion route, so no user is ever soft-deleted. Keep filtering
  it (the column is real and #56 intends to use it); just don't infer from those filters that
  account deletion exists. `Dashboard.deleted_at` means **in the trash** (#40) —
  filter it in every access/listing/inheritance query — it is the *only* put-away flag now
  (`archived` was removed 2026-07-27, on dashboards and lists alike). Only `DashboardWidget`
  is hard-deleted. The purge cascade lives in `services/retention.reap_expired_trash` — and it
  sweeps children **by hand** because their `dashboard_id` FKs have no `ON DELETE CASCADE`. The one
  exception is `resource_shares.resource_id`, which does cascade, so shares are not swept there at
  all. Adding a child table means adding it to that sweep, or its rows outlive the purge.
- **`reap_abandoned_signups` is the one sweep that deletes a `User`.** It takes accounts with
  `email_verified_at IS NULL` past `unverified_retention_days` **that own no content**, and only
  those **created on or after `_EMAIL_VERIFICATION_SHIPPED` (2026-04-30)**. That date floor is the
  real protection, not the content check. `NULL` means two different things: after the gate shipped
  it means "signed up, never verified"; before it, the column simply did not exist (migration
  `y2a4c6e8g0i2` added it nullable and never backfilled), so **every pre-gate account reads
  unverified forever** however ordinary it is. The content check was believed to cover them and does
  not — a pre-gate user who only ever *viewed* a dashboard shared with them authored nothing,
  granted nothing and was assigned nothing, and being a share **principal** is explicitly not
  disqualifying (the sweep deletes those rows). That user was silently deleted until 2026-07-29;
  both cases are now pinned in `test_retention.py`. It **filters per user** — an earlier version
  vetoed the whole sweep when any candidate owned content, which let one real account shield every
  other candidate.
  Candidate ids are resolved to a list up front rather than left as a subquery, because each
  `DELETE` would otherwise re-evaluate it after earlier statements had removed rows it reads.
  Adding a table with a `users` FK means adding it to this sweep too — none of those FKs cascade.
- `log_event(...)` and `stage_notification(...)` only `db.add` — the route owns the single
  commit so events land in the same transaction as the mutation.
- **SSE ordering is load-bearing:** build the event dict (`app/sse/events.py` — flush/refresh)
  *before* commit; `manager.broadcast(...)` *after* commit. Broadcast to
  `{dashboard.user_id} ∪ share principal_ids` or other users' open tabs silently go stale.
- Layout/widget writes need the dashboard row lock (`lock_for_update=True`) **and** a
  `dashboard.version` bump; `PUT /layout` compares client vs. server version (409 on mismatch).
- **Auth is one opaque cookie, and identity changes need no cookie work.** The `session` cookie
  carries no claims — its SHA-256 is a `sessions` row, resolved on every request
  (`services/sessions.resolve_session`). There is no access token, no refresh token, no
  `/auth/refresh`. A route mutating identity fields used to have to re-mint the JWT because it
  embedded `email`; it does not now. `resolve_session` is also the **single writer** of
  `last_used_at` (throttled) — don't bump it by hand in a route, or the idle clock gets two
  owners again.

## The schema is the frontend's contract
- The frontend's types are **generated** from this app's OpenAPI document (ADR-018), so a shape
  the client reads must be expressible there: give every route a real `response_model` (no bare
  `dict`), and register non-response shapes (the SSE frames in `app/schemas/sse.py`) as models so
  they land in `components.schemas`. After changing any of it, run `make contracts` from the repo
  root and commit the regenerated `frontend/src/api/generated/contract.ts` — CI fails on drift.
- `app/openapi_export.py` is the export step (`python -m app.openapi_export`), not app code. It
  widens single-value `const` to a one-member `enum`, because the zod generator ignores `const`
  and would degrade every `Literal` discriminator to a plain string.

## Migrations & models
- Alembic revisions are hand-authored 12-char slugs with explicit `down_revision` chaining —
  match the style. Role/type enums are stored as plain `String` (StrEnum), not PG enums.
- **A new model module must be imported in `alembic/env.py`** or it's invisible to autogenerate.
  It also needs its own migration: the test schema is built by `alembic upgrade head`, so a model
  without a migration has no table and every test touching it fails. Nothing needs adding to
  `tests/conftest.py` — it no longer imports models.

## Tests & email
- Integration tests build the schema with **`alembic upgrade head`** (not `create_all`), against a
  `POSTGRES_IMAGE` Testcontainer (default `postgres:17-alpine`, shared with `docker-compose.yml`
  and asserted equal in `test_config.py` — dumps don't cross major versions) or an existing
  database via `TEST_DATABASE_URL`. **Migrations
  are exercised on every run**, and `tests/test_migrations.py` fails the build on ORM↔migration
  drift via `alembic check` — but note that check is blind to `server_default`s and CHECK
  constraints, so those still need asserting by hand. Each test runs in a rolled-back savepoint.
- Tests are **auto-marked**: anything using the `test_database` fixture becomes `integration`,
  everything else `unit`. So `make test-unit` (`pytest -m unit`) runs with no Docker at all — which
  means **any test touching Postgres must go through the `test_database` fixture**, or it gets
  mismarked as a unit test and runs without a database.
- Tests monkeypatch email senders by the *router's* import path
  (`app.routers.auth.send_verification_email`) — import/call them that way. Emails go through
  `BackgroundTasks`, always queued after `db.commit()`.
- **Getting a token locally:** with `resend_api_key` unset *and* `ENVIRONMENT=development`, the
  rendered message is written to `backend/.dev-mail/` (gitignored) — open the newest `.txt` for the
  link. It is **not** logged: verification and reset URLs are bearer credentials, and the gate is
  the environment rather than the missing key, because a missing key is the default (finding #42).
  Any other environment without a key logs that the mail was dropped and sends nothing.
- **Asserting on log output needs the `logs` fixture pattern** (`tests/test_email_delivery.py`):
  `app.main` sets `propagate = False` on the "app" logger, and `caplog` listens at the root, so a
  plain `caplog` captures nothing and every negative assertion passes vacuously.
