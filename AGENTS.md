# Instructions for Agents

Read this file first. It contains repo-wide rules that should not be hidden in path-specific
guidance. It is the only file of its kind — there are no per-stack variants, so a convention that
bites belongs here, in the relevant ADR/FDR, or in a comment at the code it governs.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; tools refuse to write through the link.

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
  especially `live-verify`, `doc-checkup` and `security-review`.

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
- **Work on a branch and open a PR. Never commit to `main` directly.** A `pre-push` hook refuses
  it, because the plan cannot enforce it: branch protection needs a public repo or GitHub Pro.
- Group commits logically: batch related work into coherent commits, don't micro-commit, don't
  lump unrelated changes together.
- **Commit at the end of a coherent unit, not as each piece arrives.** Work, show the diff, adjust,
  then commit by logical separation. Splitting on the order a conversation happened to arrive in is
  how a four-commit branch becomes seven. A commit fixing a defect another commit in the same
  unmerged branch introduced is an amend — pushed or not, a reviewer should never meet a bug and
  its fix in one PR.
- Use Conventional Commit messages (`type(scope): description`, hook-normalized and enforced).
  The **PR title** is Conventional too — a squash merge keeps it as the subject on `main`, and no
  CI gate checks it, so verify it by eye before merging. Never add a
  `Co-Authored-By` or attribution trailer.
- Never run `docker compose down -v` — it wipes the database volume. Target volumes by name if one
  must be removed.
- Prod is behind Cloudflare. A static asset not updating after a deploy means purge the Cloudflare
  cache first, not rebuild.

## Commits & PRs

- Run the `pr-checklist` skill **before opening a PR and again before asking for a merge**. It owns
  the required body shape and the docs/ADR/FDR sweep, so a hand-written body drifts from house
  standard without it. `.github/pull_request_template.md` prefills the same headings; change the
  two together.
- Open full, ready-for-review PRs. Draft only when explicitly asked.
- CI runs on every PR to `main`, and merging is what publishes images. Check CI after opening and
  fix failures that are regressions from `main`.
- Deploying is [docs/runbooks/deploy.md](docs/runbooks/deploy.md): merge, wait for the publish,
  then **check for updates and update** the stack in Unraid's Compose Manager. Production is driven
  through that plugin's UI, not `docker compose` on the host.

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
make audit       # dependency CVE audit (osv-scanner, both lockfiles)
```

- `/live-verify` runs the real production images against a throwaway database and drives them in a
  browser — the only check that sees a blank page, a stray refetch, or a serving/caching fault.
  After a deploy, verify the live site from outside with the checks in
  [docs/runbooks/deploy.md](docs/runbooks/deploy.md), read-only.
- Backend integration tests need PostgreSQL: either a Docker socket (Testcontainers) or
  `TEST_DATABASE_URL` pointing at a dedicated test database. `make test-unit` needs neither.
- CI runs lint, tests, `ty` type checking and the frontend build on every push and PR — except
  docs-only changes (`docs/**`, `**.md` at any depth), which skip it. On a PR touching only one
  side, the other side's job is skipped. Keep it green.
- MCP servers are declared once per tool — `.mcp.json` for Claude Code, `.codex/config.toml` for
  Codex. Nothing syncs them; change both or one agent silently loses the server.

## Architecture

- `backend/` — Python 3.14+, FastAPI, SQLAlchemy 2.0 (async), Alembic migrations, PostgreSQL 17.
- `frontend/` — React 19 + TypeScript, Vite, Tailwind CSS, Zustand stores, react-grid-layout v2.
- Infra — Docker Compose (dev + prod variants), Caddy reverse proxy (prod), `uv` and `npm`.
- **Redis** — bundled in each stack, holding the rate-limit windows and the SSE fan-out stream. Not
  a cache and not a source of truth: nothing durable lives there, and both consumers keep serving
  without it ([ADR-013](docs/adr/ADR-013-rate-limit-cf-connecting-ip.md),
  [ADR-004](docs/adr/ADR-004-sse-over-websocket.md)).
- **Sharing model**: per-resource `ResourceShare` rows. Dashboards are shared directly with users
  (viewer/editor, owner = creator); lists and calendar events **inherit** access from the
  dashboard whose widget binds them, so their `/shares` endpoints are deliberate 409 stubs.
- **Delete boundary**: recoverable where reconstruction is expensive. Dashboards and lists go to a
  trash on DELETE, restorable for 30 days or purgeable on demand; a calendar event is tombstoned and
  undoable from its deletion toast; list items and widgets are removed outright. Every tombstone has
  an endpoint that clears it — one without is a bug
  ([ADR-007](docs/adr/ADR-007-soft-delete-boundary.md)).
- **Auth**: one opaque session cookie (HttpOnly, `__Host-` prefixed in prod) resolved against a
  `sessions` row on every request, plus an `Origin` check and CSRF double-submit. No JWT, no
  refresh token, no `/auth/refresh`, no localStorage tokens
  ([ADR-002](docs/adr/ADR-002-jwt-httponly-cookies-csrf.md),
  [ADR-003](docs/adr/ADR-003-first-class-sessions.md)).
- **Real-time**: SSE, not WebSocket; one multiplexed connection per open tab, fanned out by user —
  a laptop, a phone and a second tab are three streams, not one. Fan-out reaches the other workers
  over a Redis stream: delivered locally first, published after, and a lost frame is repaired by the
  reader's resync on recovery rather than retried.
- **State**: Zustand stores shared between widgets and full pages. REST for the initial fetch, SSE
  for incremental updates.
- **API contract**: the backend's OpenAPI document is authoritative. The frontend's types are
  generated from it (`make contracts`, committed, CI fails on drift) and every response body is
  validated at the network boundary. Never hand-write a client DTO.

## Which Rules Fail the Build

Most rules in this file are judgment you are trusted with. These eight are not — each has a test
that fails CI, and its failure message tells you what to do. Everything else here is guidance,
so if you are wondering whether a convention bites, this table is the answer.

| Convention | Guard | Why |
|---|---|---|
| Mutating routes carry `@limiter.limit` | `test_rate_limit_coverage.py` | [ADR-013](docs/adr/ADR-013-rate-limit-cf-connecting-ip.md) |
| Auth rejections raise `auth_failure(...)` | `test_auth_failure_coverage.py` | Below, *Backend Principles* |
| Fan-out goes through `commit_and_broadcast` | `test_sse_choreography_coverage.py` | [ADR-015](docs/adr/ADR-015-sse-write-choreography.md) |
| `changed_fields` stays inside its vocabulary | `test_changed_fields_coverage.py` | [FDR-008 §10](docs/fdr/FDR-008-realtime-sse.md) |
| A labelled metric pre-creates its children | `test_observability_coverage.py` | Below, *Backend Principles* |
| Every activity type has feed copy + a category | `test_activity.py` | Below, *Frontend Principles* |
| Node is pinned once, in `.nvmrc` | `test_toolchain_coverage.py` | — |
| `react-resizable` tracks react-grid-layout | `test_frontend_pin_coverage.py` | — |

These guards read source, so a refactor can make one **pass having checked nothing** — the
dangerous failure, because a silent guard looks exactly like a satisfied one. Three rules follow
from that:

- A guard that discovers what to check must fail when it discovers nothing. Parametrizing over the
  discovery is how: `empty_parameter_set_mark = "fail_at_collect"` turns an empty set into a
  collection error, where the default skips and exits 0. A guard that instead reads a fixed list
  asserts on it directly, as `test_rate_limit_coverage.py` does.
- Enumerate router sources through `backend/tests/conventions.py`, which walks with `rglob` so a
  router that grows into a package stays covered. Another directory may be globbed directly.
- Match the shape you mean. A guard scraping `case '...'` for event types must require the dotted
  form, or an unrelated inner `switch` joins the result and a `default:` truncates the scan.

## Backend Principles

- Every non-GET route needs `_csrf: None = Depends(require_csrf)` **and**
  `@limiter.limit(WRITE_LIMIT)` with a `request: Request` parameter. CSRF is a dependency, not
  middleware, and slowapi's app-wide limit cannot see through included-router nesting — so both
  are per route, and `test_rate_limit_coverage.py` fails the build on a missing limit. Beware that
  same nesting in any audit over `app.routes`, which passes having checked nothing.
- A route creating a row in a table with no retention horizon takes `assert_under_quota(...)` first.
  Counts include trashed rows on purpose — a live-only count is bypassed by delete-and-recreate
  ([ADR-020](docs/adr/ADR-020-resource-quotas.md)). No guard enforces this; adding one wants a
  registry of quota-bearing tables rather than a scrape.
- Reject an authentication attempt with `raise auth_failure(...)`, never a bare `HTTPException`:
  building the 401/403 and counting it are one call, and `test_auth_failure_coverage.py` fails the
  build on a bare raise in the auth layer. Authorization refusals are a different thing and stay out.
- One role vocabulary, two types. `EffectiveRole` (owner/editor/viewer) is what
  `permissions.effective_role` computes — owner for the creator, 404 for no access. `ShareRole` —
  what a row stores and a client may request — is a `Literal` subset **derived** from it, so
  `owner` is unrequestable by construction. Don't reintroduce a second enum, and go through
  `as_share_role` when narrowing a stored value.
- Child resources reach access through `load_dashboard_access` / `list_accessible_dashboard_ids`,
  which filter trashed dashboards. Querying a child table directly breaks that invariant.
- SSE ordering is load-bearing. Commit and fan out through `commit_and_broadcast(...)`; a router
  never calls `manager.broadcast` directly — `test_sse_choreography_coverage.py` fails the build on
  that, and the fan-out reader in `sse/broker.py` is the one legitimate caller elsewhere, delivering
  a sibling worker's already-committed frame. Still yours: build the event dict *before* the call,
  and address it with `dashboard_audience_user_ids(...)`.
- **Anything reaching Redis degrades; it never fails the request.** The limiter falls back to
  per-process buckets and the fan-out to local-only delivery, each with a metric saying so. A
  third consumer that raises when Redis is down turns a degradation into an outage.
- A new **labelled** metric names its children at import, over the bounded set of label values it
  can take. A child is created on first use and so is born at 1, leaving `increase()` nothing to
  diff against and reporting 0 through the very event it counts; `test_observability_coverage.py`
  fails the build on an empty family. Only a genuinely unbounded label (route) is exempt.
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
- A wire vocabulary the client branches on — `changed_fields`, resync `scopes` — is closed and
  generated from the backend enum, and an unrecognised value must **widen** the response: refetch,
  don't suppress. A newer backend must never talk an older tab out of refreshing;
  `test_changed_fields_coverage.py` fails the build on a producer inventing a value.
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
- **A closed port is not an outage.** Timing a failure path against `connection refused` measures
  nothing: a downed host blackholes instead, and the same connect cost 0.26s one way and 45s the
  other. Stop the real service, or assert on the setting that bounds it rather than on the clock.
- Argon2 runs at its **minimum** cost across the backend suite — the real profile is ~64 MiB and
  four threads per operation, and most tests register or log in. Take the `production_argon2`
  fixture to assert on the real profile; `test_hashing.py` guards it against a dependency bump.

## Documentation Updates

- A feature landing or being deliberately deferred → fold its *current behavior* into the right
  CONTEXT.md section. It is a snapshot, not a changelog.
- A cross-cutting architectural decision → add or amend an ADR and update `docs/adr/INDEX.md`
  (`adr` skill). Supersede rather than delete when a decision is replaced. A decision local to one
  feature belongs in that feature's FDR.
- A feature's behavior or rationale changing → rewrite the affected FDR section in place, bump
  **Last reviewed**, and cite any new ADR (`fdr` skill).
- A project-specific term being coined or renamed → add or rewrite its `docs/GLOSSARY.md` entry in
  the right section and cross-link the owning FDR/ADR (`glossary` skill).
- A backlog finding shipping or being deferred → remove or update its `docs/TODO.md` item in the
  same change. The execution detail lives in the commit; don't reproduce it in a doc.
- A new standing rule or gotcha → this file.

## Git Hooks

`make hooks`, once per clone, installs [pre-commit](https://pre-commit.com/) via `uv` for all
stages: pre-commit (ruff, biome, deptry, gitleaks, whitespace), prepare-commit-msg (subject
normalization), commit-msg (Conventional Commit enforcement — `feat`, `fix`, `docs`, `refactor`,
`chore`, `test`, `ci`, `perf`, `style`, `build`, `revert`), and pre-push (refuses a push to
`main`).
