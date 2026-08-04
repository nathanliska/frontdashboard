# Instructions for Agents

Read this file first. It contains repo-wide rules that should not be hidden in path-specific
guidance. It is the only file of its kind — there are no per-stack variants, so a convention that
bites belongs here, in the relevant ADR/FDR, or in a comment at the code it governs.

## Where Context Lives

- [README.md](README.md) — general project overview.
- [CONTEXT.md](CONTEXT.md) — current project state (built / in flight / deferred). Read it first
  to orient.
- [docs/adr/INDEX.md](docs/adr/INDEX.md) — Architecture Decision Records: *why* the cross-cutting
  architecture is the way it is (context, decision, consequences).
- [docs/fdr/INDEX.md](docs/fdr/INDEX.md) — Feature Decision Records: *what* each feature does
  behaviorally and the design decisions behind it. Citations flow FDR → ADR only.
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — canonical vocabulary (UI / Product / Access / Backend).
- [docs/TODO.md](docs/TODO.md) — the open remediation backlog; findings keep their numbers. Closed
  work lives in git history.
- [docs/runbooks/](docs/runbooks/) — operational procedures for the day something is broken. Prose
  aimed at a person under pressure, not architecture; the *why* still belongs in an ADR/FDR.
- `.agents/skills/**` — workflow skills. Use them when the task names one or clearly matches one,
  especially `live-verify`, `deploy-verify`, and `doc-checkup`.

## Project Status

- Self-hosted household dashboard app — a "household operating system": shared where coordination
  matters, private where personal space matters, modular in layout. Monorepo: `backend/`
  (FastAPI/Python) + `frontend/` (React/TypeScript).
- **Do not infer the deployment posture from the domain.** The product is household-shaped; the
  deployment is not private. One instance is public on the internet with registration open to
  anyone holding a verifiable email, ~100 users and a few concurrent, on one backend worker today.
- **Scaling readiness is wanted, in both directions.** Adding a replica should be a config change,
  not a rewrite — so shared state, fan-out and limits belong on that footing even while the stack
  runs one. Replicas are the axis, not uvicorn workers, which break metrics collection outright.
  Don't propose deferring this work.
- Abuse, enumeration and data-privacy findings get no small-deployment discount — "only a logged-in
  user can reach it" is not a mitigation when anyone can sign up.

## Prime Directives

- Prefer simple, clear changes over clever abstractions.
- Follow the language's documentation standard. Python docstrings are [PEP 257](https://peps.python.org/pep-0257/):
  a one-line summary that fits on its own line, a blank line before any elaboration, closing
  quotes on their own line for multi-line strings. Enforced by Ruff's `D2`/`D4` rules. Exported
  TypeScript uses [TSDoc](https://tsdoc.org/)-style `/** */` blocks.
- Write a docstring when a symbol is part of the public API, is of nontrivial size, or has
  non-obvious logic — the [Google style guide](https://google.github.io/styleguide/pyguide.html)
  test. A name and signature that already describe the thing need no restatement.
- Comments explain *why*, never *what*: "never describe the code", per the same guide. Assume the
  reader knows the language. Don't restate the types — argument and return shapes are in the
  signature — but do record invariants, lifecycle behavior, and what a call raises when a caller
  must handle it.
- **Hard cap: three lines per comment.** Being a genuine *why* is no exemption — length is its own
  rule. Longer means the rationale belongs in an ADR/FDR: write it there and link it.
- Keep change history out of comments. No "this used to…", no finding or ticket numbers. Durable
  rationale belongs in the ADR/FDR; how a change came about belongs in the commit body.
- Keep tests and documentation up to date when changing behavior.
- Run verification that would actually catch a regression in the area touched, and never claim
  full verification when only a partial signal was run.
- Never silence a lint, type, or build warning as a routine fix. Fix the cause; discuss rare
  scoped exceptions before adding them.
- Never log bearer credentials: verification and reset URLs, session or CSRF tokens, invite codes,
  or password material.

## Hard Rules

Standing user constraints. Do not violate these.

- Confirm before commit **and** before push — the user reviews the files first, every time.
- Commit straight to `main` (sole contributor). No feature branches unless explicitly asked.
- Group commits logically: batch related work into coherent commits, don't micro-commit, don't
  lump unrelated changes together.
- Use Conventional Commit messages (`type(scope): description`, hook-normalized and enforced).
  Never add a `Co-Authored-By` or attribution trailer.
- Never run `docker compose down -v` — it wipes the database volume. Target volumes by name if one
  must be removed.
- Prod is behind Cloudflare. A static asset not updating after a deploy means purge the Cloudflare
  cache first, not rebuild.

## Tooling

```sh
make test        # all tests (backend pytest + frontend vitest + typecheck)
make typecheck   # type checks only (backend ty + frontend tsc --build)
make contracts   # regenerate the frontend API contract from the backend schema
make lint        # backend Ruff + frontend Biome
make format      # format both sides
make dev-up      # start all services (Docker Compose)
make migrate     # run Alembic migrations
make seed        # seed development data
make audit       # dependency/security audit checks
```

- `/live-verify` runs the real production images against a throwaway database and drives them in a
  browser — the only check that sees a blank page, a stray refetch, or a serving/caching fault.
  `/deploy-verify` smoke-checks the live site over HTTPS afterwards, read-only.
- Backend integration tests need PostgreSQL: either a Docker socket (Testcontainers) or
  `TEST_DATABASE_URL` pointing at a dedicated test database. `make test-unit` needs neither.
- CI runs lint, tests, `ty` type checking and the frontend build on every push and PR. Keep it
  green.

## Architecture

- `backend/` — Python 3.14+, FastAPI, SQLAlchemy 2.0 (async), Alembic migrations, PostgreSQL 17.
- `frontend/` — React 19 + TypeScript, Vite, Tailwind CSS, Zustand stores, react-grid-layout v2.
- Infra — Docker Compose (dev + prod variants), Caddy reverse proxy (prod), `uv` and `npm`.
- **Sharing model**: per-resource `ResourceShare` rows. Dashboards are shared directly with users
  (viewer/editor, owner = creator); lists and calendar events **inherit** access from the
  dashboard whose widget binds them, so their `/shares` endpoints are deliberate 409 stubs.
- **Soft delete**: `deleted_at` on lists/items/events; dashboards and lists go to a trash on
  DELETE, restorable for 30 days before the reaper purges the cascade. There is no archive state —
  one recoverable put-away action ([ADR-007](docs/adr/ADR-007-soft-delete-boundary.md)).
- **Auth**: one opaque session cookie (HttpOnly, `__Host-` prefixed in prod) resolved against a
  `sessions` row on every request, plus an `Origin` check and CSRF double-submit. No JWT, no
  refresh token, no `/auth/refresh`, no localStorage tokens
  ([ADR-002](docs/adr/ADR-002-jwt-httponly-cookies-csrf.md),
  [ADR-003](docs/adr/ADR-003-first-class-sessions.md)).
- **Real-time**: SSE, not WebSocket; one multiplexed connection per user.
- **State**: Zustand stores shared between widgets and full pages. REST for the initial fetch, SSE
  for incremental updates.
- **API contract**: the backend's OpenAPI document is authoritative. The frontend's types are
  generated from it (`make contracts`, committed, CI fails on drift) and every response body is
  validated at the network boundary. Never hand-write a client DTO.

## Backend Principles

- Every non-GET route needs `_csrf: None = Depends(require_csrf)` **and**
  `@limiter.limit(WRITE_LIMIT)` with a `request: Request` parameter. CSRF is a dependency, not
  middleware, and slowapi's app-wide limit cannot see through included-router nesting — so both
  are per route, and `test_rate_limit_coverage.py` fails the build on a missing limit. Beware that
  same nesting in any audit over `app.routes`, which passes having checked nothing.
- Reject an authentication attempt with `raise auth_failure(...)`, never a bare `HTTPException`:
  building the 401/403 and counting it are one call, and `test_auth_failure_coverage.py` fails the
  build on a bare raise in the auth layer. Authorization refusals are a different thing and stay out.
- `role is None` means **owner**, not "no access". `permissions.effective_role` returns `None` for
  the creator and raises 404 for no access; never write `if role:` guards.
- Child resources reach access through `load_dashboard_access` / `list_accessible_dashboard_ids`,
  which filter trashed dashboards. Querying a child table directly breaks that invariant.
- SSE ordering is load-bearing. Commit and fan out through `commit_and_broadcast(...)`, never
  `manager.broadcast` directly — `test_sse_choreography_coverage.py` fails the build on that. Still
  yours: build the event dict *before* the call, and address it with `dashboard_audience_user_ids(...)`.
- `log_event(...)` and `stage_notification(...)` only `db.add` — the route owns the single commit.
- Layout and widget writes need the dashboard row lock and a `dashboard.version` bump;
  `PUT /layout` compares client against server version and 409s on mismatch.
- Adding a table with a `dashboard_id` or `users` foreign key means adding it to the matching
  sweep in `services/retention.py`. None of those FKs cascade, so a missed one either outlives the
  purge or rolls back the whole tick.
- A new model module must be imported in `alembic/env.py` and needs its own hand-authored
  migration; the test schema is built by `alembic upgrade head`.
- Any test touching Postgres must go through the `test_database` fixture, or it is auto-marked a
  unit test and runs without a database.

## Frontend Principles

- Zustand `stores/` hold app and session state; list, calendar and agenda data live in
  `resources/*` on top of `createScopedQuery`. Don't put resource data in a store.
- A mutation's response is the truth — apply it, never refetch it. A GET right after your own
  successful write is a bug. The sanctioned refetches are 409 divergence, server-derived data the
  client cannot compute, and someone else's change arriving via a non-echo SSE event.
- A new entity type needs both its event names in `hooks/useSSE.ts` and a `handleXResourceEvent`
  router in `resources/*`. Miss either and the UI silently goes stale.
- The echo check consumes, so ask once at the router and pass the verdict down. Suppressing an
  echo obliges you to patch whatever the refetch would have refreshed.
- A new activity event type needs a `formatActivityEvent` case **and** a place in one of
  `ACTIVITY_CATEGORIES`, or it renders as a raw string and no filter can reach it;
  `test_activity.py` fails the build on either.
- `isOwnFeedActivity` is the only gate on live activity appends, and must keep answering exactly
  what `GET /api/activity` would — actor and active filter. A frame it admits that the
  endpoint would not serve back is a row the next reload silently deletes.
- A new resource cache calls `registerResourceReset(...)` at module scope, beside the cache it
  clears. `stores/auth.ts` calls the registry, not each reset by name.
- Only `401` means logged out. Not `403`, which is the permission layer, and never a `5xx`,
  timeout or network rejection.
- `apiFetch` is the only network entry for `/api`; every success body goes through
  `parseJson(res, Schema)`. Retries are GET-only, for echo suppression rather than idempotency.
- Validate forms through `ui/FormField` (or the same aria wiring inline), never a toast. Modals go
  through `ui/Dialog`; row actions through `ui/OverflowMenu`.
- Anything a module schedules must be cancellable and cancelled in `test/setup.ts` — a worker is
  reused across files, so an uncleared timer keeps its store alive for the rest of the run.

## Testing Judgment

- Pick the lowest test layer that exercises the change, but do not stop below the layer where the
  bug could occur.
- If a change alters *how* a result is produced rather than *what* it is, asserting on the result
  proves nothing. Scoped-query eviction and the calendar window predicate both shipped tests that
  passed against the unfixed code. Assert on the mechanism instead — `getState` rather than the
  DOM, a counter on what reached the expander rather than the response body.
- Prove a test by breaking the thing back: stash the change, watch it fail, restore. A performance
  or caching test that has never been seen to fail is not evidence.

## Documentation Updates

- A feature landing or being deliberately deferred → fold its *current behavior* into the right
  CONTEXT.md section. It is a snapshot, not a changelog.
- A cross-cutting architectural decision → add or amend an ADR and update `docs/adr/INDEX.md`.
  Supersede rather than delete when a decision is replaced. A decision local to one feature
  belongs in that feature's FDR.
- A feature's behavior or rationale changing → rewrite the affected FDR section in place, bump
  **Last reviewed**, and cite any new ADR.
- A project-specific term being coined or renamed → add or rewrite its `docs/GLOSSARY.md` entry in
  the right section and cross-link the owning FDR/ADR.
- A backlog finding shipping or being deferred → remove or update its `docs/TODO.md` item in the
  same change. The execution detail lives in the commit; don't reproduce it in a doc.
- A new standing rule or gotcha → this file.

## Git Hooks

`make hooks`, once per clone, installs [pre-commit](https://pre-commit.com/) via `uv` for all
stages: pre-commit (ruff, biome, deptry, whitespace), prepare-commit-msg (subject normalization),
and commit-msg (Conventional Commit enforcement — `feat`, `fix`, `docs`, `refactor`, `chore`,
`test`, `ci`, `perf`, `style`, `build`, `revert`).
