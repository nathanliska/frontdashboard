# CLAUDE.md — FrontDashboard

Self-hosted household dashboard app — a "household operating system": shared where coordination
matters, private where personal space matters, modular in layout. Monorepo: `backend/`
(FastAPI/Python) + `frontend/` (React/TypeScript). This file is the project memory for agents
working in this repo.

**Deployment posture — don't infer it from the domain.** The product is household-shaped; the
deployment is not private. One instance is public on the internet with registration open to anyone
holding a verifiable email, ~100 users and a few concurrent, on a single backend worker. So:
scale-driven work (metrics stacks, multi-worker, fleet tooling) stays deferred, while abuse,
enumeration and data-privacy findings get no small-deployment discount — "only a logged-in user can
reach it" is not a mitigation when anyone can sign up. See the Scale/Exposure notes in
[docs/TODO.md](docs/TODO.md).

## Architecture (3 layers)
- `backend/` — Python 3.12+, FastAPI, SQLAlchemy 2.0 (async), Alembic migrations, PostgreSQL 17.
- `frontend/` — React 19 + TypeScript, Vite, Tailwind CSS, Zustand stores, react-grid-layout v2.
- Infra — Docker Compose (dev + prod variants), Caddy reverse proxy (prod), `uv` (Python),
  `npm` (Node).

## Build / test / lint (run before claiming done)
```bash
make test        # all tests (backend pytest + frontend vitest + typecheck)
make typecheck   # type checks only (backend ty + frontend tsc --build)
make contracts   # regenerate the frontend API contract from the backend schema
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
- **API contract**: the backend's OpenAPI document is authoritative — the frontend's types are
  generated from it (`make contracts`, committed, CI fails on drift) and every response body is
  validated at the network boundary. Never hand-write a client DTO.

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
- **[docs/adr/INDEX.md](docs/adr/INDEX.md)** — Architecture Decision Records: *why* the
  cross-cutting architecture is the way it is (context, decision, consequences).
- **[docs/fdr/INDEX.md](docs/fdr/INDEX.md)** — Feature Decision Records: *what* each feature does
  behaviorally and the design decisions behind it (cite ADRs, one direction FDR → ADR).
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** — canonical vocabulary (UI / Product / Access / Backend).
- **[docs/TODO.md](docs/TODO.md)** — the open remediation backlog (findings keep their numbers).
  Closed work lives in git history; its durable decisions are distilled into the ADRs/FDRs.
- `backend/CLAUDE.md` and `frontend/CLAUDE.md` — stack-specific conventions and gotchas
  (auto-loaded when working in those trees).

## Documentation updates (which doc to touch, when)
- **Feature lands or is deliberately deferred** → fold its *current behavior* into the right
  CONTEXT.md section (it's a snapshot, not a changelog).
- **A cross-cutting architectural decision is made/changed** → add or amend an ADR in `docs/adr/`
  and update `docs/adr/INDEX.md`. Supersede (don't delete) when a decision is replaced. A decision
  local to one feature belongs in that feature's FDR, not an ADR.
- **A feature's behavior or design rationale changes** → update its FDR in `docs/fdr/` (rewrite the
  affected section — FDRs describe the feature *today*, not a changelog), bump **Last reviewed**,
  and cite any new ADR (citations flow FDR → ADR only).
- **A project-specific term is coined or renamed** → add/rewrite its `docs/GLOSSARY.md` entry in the
  right section (UI / Product / Access / Backend) and cross-link the owning FDR/ADR.
- **A backlog finding ships or is deferred** → remove (or update) its item in `docs/TODO.md` in the
  same change; if it established a cross-cutting decision, write/amend the ADR too. The execution
  detail lives in the commit — don't reproduce it in a doc.
- **New standing rule or gotcha discovered** → this file (or the stack CLAUDE.md it belongs to).
