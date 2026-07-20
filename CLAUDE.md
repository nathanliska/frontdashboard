# CLAUDE.md — FrontDashboard

Self-hosted household dashboard app — a private "household operating system": shared where
coordination matters, private where personal space matters, modular in layout. Monorepo:
`backend/` (FastAPI/Python) + `frontend/` (React/TypeScript). This file is the project memory
for agents working in this repo.

## Architecture (3 layers)
- `backend/` — Python 3.12+, FastAPI, SQLAlchemy 2.0 (async), Alembic migrations, PostgreSQL 16.
- `frontend/` — React 19 + TypeScript, Vite, Tailwind CSS, Zustand stores, react-grid-layout v2.
- Infra — Docker Compose (dev + prod variants), Caddy reverse proxy (prod), `uv` (Python),
  `npm` (Node).

## Build / test / lint (run before claiming done)
```bash
make test        # all tests (backend pytest + frontend vitest + typecheck)
make lint        # backend Ruff + frontend Biome
make format      # format both sides
make dev-up      # start all services (Docker Compose)
make migrate     # run Alembic migrations
make seed        # seed development data
make audit       # dependency/security audit checks
make audit-fix   # apply npm audit fixes (frontend)
```
- Backend: `uv run ruff check --fix` / `uv run ruff format`. Backend **integration** tests need
  PostgreSQL — either a Docker socket (Testcontainers) or `TEST_DATABASE_URL` pointing at a
  dedicated test database. `make test-unit` (`pytest -m unit`) needs neither.
- Frontend: `npm run lint` / `npm run lint:fix` / `npm run format` (Biome), `npm test` (Vitest).
- CI (GitHub Actions) runs backend + frontend lint, tests, `ty` type checking, and the
  frontend build on every push and PR. Keep it green.

## Key architecture decisions
- **Sharing model** (groups were removed): per-resource `ResourceShare` rows — dashboards are
  shared directly with users (viewer/editor, owner = creator); lists and calendar events
  **inherit** access from the dashboard whose widget binds them (their `/shares` endpoints are
  deliberate 409 stubs). Soft delete via `deleted_at` on lists/items/events; dashboards are
  hard-deleted.
- **Auth**: JWT in HttpOnly cookies + CSRF double-submit pattern. No localStorage tokens.
  Email verification (required for login) + password reset flows; emails send in
  background tasks.
- **Real-time**: SSE (not WebSocket), single multiplexed connection per user.
- **State**: Zustand stores shared between widgets and full pages. REST for initial fetch,
  SSE for incremental updates.
- **Dashboards**: multiple per user, favorites + archiving, react-grid-layout with a version
  integer for conflict detection (stale layout save → 409).

## HARD RULES (standing user constraints — do not violate)
- **Confirm before commit AND before push** — the user reviews the files first, every time.
- **Commit straight to `main`** (sole contributor). No feature branches unless explicitly asked.
- **Logical grouped commits** — batch related work into coherent commits; don't micro-commit,
  don't lump unrelated changes together.
- **Conventional Commit messages** (`type(scope): description` — hook-normalized and enforced);
  **NO `Co-Authored-By` / attribution trailer.**
- **Never `docker compose down -v`** — it wipes the database volume. Target volumes by name
  if one must be removed.
- **Prod is behind Cloudflare** — a static asset not updating after deploy means purge the
  Cloudflare cache first, not a rebuild.

## Git hooks
`make hooks` (once per clone) installs [pre-commit](https://pre-commit.com/) via `uv` for all
stages: pre-commit (ruff, biome, deptry, whitespace), prepare-commit-msg (subject
normalization), commit-msg (Conventional Commit enforcement — types: `feat`, `fix`, `docs`,
`refactor`, `chore`, `test`, `ci`, `perf`, `style`, `build`, `revert`).

## Where to read more
- **[CONTEXT.md](CONTEXT.md)** — current project state (built / in flight / deferred). Read it
  first to orient.
- `docs/references/` — standing policy + living reference docs; `docs/designs/` — in-flight
  work; `docs/shipped/` — closed work. A doc moves to `shipped/` only when fully done.
- `backend/CLAUDE.md` and `frontend/CLAUDE.md` — stack-specific conventions and gotchas
  (auto-loaded when working in those trees).

## Documentation updates (which doc to touch, when)
- **Feature lands or is deliberately deferred** → fold its *current behavior* into the right
  CONTEXT.md section (it's a snapshot, not a changelog).
- **Review finding ships/defers, or a remediation phase closes** → follow the update protocol
  at the top of `docs/references/review-findings.md` (dispositions, rollout table, doc moves).
  The 2026-07-11 review is remediated **security-first, one theme per phase**; that file is
  the live tracker.
- **New standing rule or gotcha discovered** → this file (or the stack CLAUDE.md it belongs to).
