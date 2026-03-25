# FrontDashboard — Claude Code Instructions

## Project Overview
Self-hosted household dashboard app. Monorepo with `backend/` (FastAPI/Python) and `frontend/` (React/TypeScript). See [PLAN.md](PLAN.md) for full architecture and [CONTEXT.md](CONTEXT.md) for current status.

## Tech Stack
| Layer | Choice |
|---|---|
| Backend | Python 3.12+, FastAPI, SQLAlchemy 2.0 (async), Alembic, PostgreSQL 16 |
| Frontend | React 18+, TypeScript, Vite, Tailwind CSS, Zustand, react-grid-layout |
| Infra | Docker Compose, Caddy, uv (Python), npm (Node) |

## Key Commands (once Makefile is populated)
```bash
make dev-up      # Start all services
make dev-down    # Stop all services
make test        # Run all tests
make lint        # Lint backend + frontend
make format      # Format backend + frontend
make migrate     # Run Alembic migrations
make seed        # Seed development data
```

## Code Standards
- **Backend**: Ruff for lint + format. Run `uv run ruff check --fix` and `uv run ruff format`.
- **Frontend**: ESLint + Prettier. Run `npm run lint` and `npm run format`.
- **Commits**: Conventional Commits enforced via `.githooks/commit-msg`. Format: `type(scope): description`. Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`.
- **No commits to main**: enforced by pre-commit hook.
- **Pre-push**: unit tests must pass.

## Architecture Decisions (key ones)
- **Visibility model**: every scoped record has `visibility` (private/shared) + `group_id` (null for private). Check constraint enforces this at DB level.
- **Auth**: JWT in HttpOnly cookies + CSRF double-submit pattern. No localStorage tokens.
- **Real-time**: SSE (not WebSocket). Single multiplexed connection per user.
- **State**: Zustand stores shared between widgets and full pages. REST for initial fetch, SSE for incremental updates.
- **Dashboards**: react-grid-layout with version integer for conflict detection.

## Hooks Setup
Custom hooks live in `.githooks/`. They are activated with:
```bash
git config core.hooksPath .githooks
```
This must be run after cloning (included in `make dev-up` / setup instructions).
