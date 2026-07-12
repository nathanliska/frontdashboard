# CLAUDE.md — FrontDashboard

Self-hosted household dashboard app — a private "household operating system": shared where
coordination matters, private where personal space matters, modular in layout. Monorepo:
`backend/` (FastAPI/Python) + `frontend/` (React/TypeScript). This file is the project memory
for agents working in this repo.

## Architecture (3 layers)
- `backend/` — Python 3.12+, FastAPI, SQLAlchemy 2.0 (async), Alembic migrations, PostgreSQL 16.
- `frontend/` — React 18 + TypeScript, Vite, Tailwind CSS, Zustand stores, react-grid-layout v2.
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
- Backend: `uv run ruff check --fix` / `uv run ruff format`; backend pytest uses
  **Testcontainers and needs a Docker socket** — it cannot run without Docker available.
- Frontend: `npm run lint` / `npm run lint:fix` / `npm run format` (Biome), `npm test` (Vitest).
- CI (GitHub Actions) runs backend + frontend lint, tests, `ty` type checking, and the
  frontend build on every push and PR. Keep it green.

## Key architecture decisions
- **Visibility model**: every scoped record has `visibility` (private/shared) + `group_id`
  (null for private), enforced by a DB check constraint. Soft delete via `deleted_at`.
- **Auth**: JWT in HttpOnly cookies + CSRF double-submit pattern. No localStorage tokens.
  Email verification + password reset flows exist; emails send in background tasks.
- **Real-time**: SSE (not WebSocket), single multiplexed connection per user.
- **State**: Zustand stores shared between widgets and full pages. REST for initial fetch,
  SSE for incremental updates.
- **Dashboards**: multiple per user/group, react-grid-layout with a version integer for
  conflict detection (stale layout save → 409).

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
**[CONTEXT.md](CONTEXT.md)** — current project state (what's built / in flight / deferred);
read it first to orient, and keep it updated as features land.

`docs/` is split by type into three sibling folders:
- **`docs/references/`** — standing policy + living reference docs (never "done"):
  `original-plan.md` (the historical v1 spec — intent and roadmap; diverged in places),
  `review-findings.md` (rolling dated review log — findings + their dispositions).
- **`docs/designs/`** — active design and in-flight work.
- **`docs/shipped/`** — full design docs for completed features (work closed).

Don't bucket by guesswork: a doc moves to `shipped/` only when its work is fully done;
anything with an in-flight remainder lives in `designs/`; standing policy or a cited
reference goes in `references/`.

## Design review remediation (active)
The 2026-07-11 review in `docs/references/review-findings.md` is being remediated
**security-first, one theme per phase**. Each phase has a spec + plan in `docs/designs/`
(`security-quick-wins-*` = Phase 1). `review-findings.md` holds the live rollout
tracker (phase → findings → status) and per-finding **Disposition** lines.
- **When a finding ships (or is deferred), update its `Disposition` line AND the rollout-status
  table in `review-findings.md` in the same change** — with date and commit SHA(s). Don't let
  the tracker drift from `git log`.
