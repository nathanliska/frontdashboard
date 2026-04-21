# FrontDashboard — Claude Code Instructions

## Project Overview
Self-hosted household dashboard app. Monorepo with `backend/` (FastAPI/Python) and `frontend/` (React/TypeScript). See [PLAN.md](PLAN.md) for full architecture and [CONTEXT.md](CONTEXT.md) for current status.

## Tech Stack
| Layer | Choice |
|---|---|
| Backend | Python 3.12+, FastAPI, SQLAlchemy 2.0 (async), Alembic, PostgreSQL 16 |
| Frontend | React 18+, TypeScript, Vite, Tailwind CSS, Zustand, react-grid-layout |
| Infra | Docker Compose, Caddy, uv (Python), npm (Node) |

## Key Commands
```bash
make hooks       # Install git hooks (once per clone)
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
- **Frontend**: Biome for lint + format. Run `npm run lint`, `npm run lint:fix`, or `npm run format`.
- **Commits**: Conventional Commits are normalized in `prepare-commit-msg` and enforced in `commit-msg`. Format: `type(scope): description`. Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `test`, `perf`, `ci`, `build`, `revert`.
- **No commits to main**: enforced by branch protection.
- **CI**: GitHub Actions runs backend/frontend lint, tests, and frontend build on push and pull request.

## Architecture Decisions (key ones)
- **Visibility model**: every scoped record has `visibility` (private/shared) + `group_id` (null for private). Check constraint enforces this at DB level.
- **Auth**: JWT in HttpOnly cookies + CSRF double-submit pattern. No localStorage tokens.
- **Real-time**: SSE (not WebSocket). Single multiplexed connection per user.
- **State**: Zustand stores shared between widgets and full pages. REST for initial fetch, SSE for incremental updates.
- **Dashboards**: react-grid-layout with version integer for conflict detection.

## Hooks Setup
Uses [pre-commit](https://pre-commit.com/), installed via `uv`. Run once after cloning:
```bash
make hooks
```
This runs `uv tool install pre-commit` then registers hooks for all active stages (pre-commit, prepare-commit-msg, commit-msg).
