# FrontDashboard

A self-hosted dashboard app that acts as a private household operating system. Shared where coordination matters, private where personal space matters, modular in layout and features.

---

## Features

- **Dashboards** — multiple per user, customizable widget layouts, favorites, archiving
- **Sharing** — share a dashboard with other users (viewer/editor); lists and events on it
  inherit access
- **Lists** — checklists, grocery lists, and todos with real-time sync
- **Calendar** — day/week/month views, recurring events, per-occurrence edits, agenda widget
- **Real-time updates** — SSE-based live sync across all connected users
- **Notifications** — in-app bell with inbox and activity history

---

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.14+, FastAPI, SQLAlchemy 2.0, Alembic, PostgreSQL 17 |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS, Zustand, react-grid-layout |
| Infra | Docker Compose, Caddy (production reverse proxy) |

---

## Getting Started

### Prerequisites

- Docker and Docker Compose
- `uv` ([install](https://docs.astral.sh/uv/getting-started/installation/))
- Node.js 20+

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/nathanliska/frontdashboard.git
cd frontdashboard

# 2. Install git hooks (once per clone or hook changes, requires uv)
make hooks

# 3. Copy and fill in environment variables
cp .env.example .env

# 4. Start all services
make dev-up
```

In dev the services run directly without Caddy:
- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000`

Caddy (`Caddyfile`) is for production — it unifies both behind port 80, adds security headers, and handles SSE flush.

---

## Development

```bash
make dev-up      # Start all services (Docker Compose)
make dev-down    # Stop all services
make test        # Run all tests
make test-unit   # Run tests that need neither PostgreSQL nor Docker
make lint        # Lint backend + frontend
make format      # Format backend + frontend
make audit       # Run dependency/security audit checks
make audit-fix   # Apply npm audit fixes for frontend dependencies
make migrate     # Run Alembic migrations
make seed        # Seed development data
make logs        # Tail service logs
```

### Testing without Docker

`make test-unit` runs the backend unit tests, backend type checks, and frontend tests without
starting PostgreSQL or Docker.

The full backend suite always uses real PostgreSQL. Set `TEST_DATABASE_URL` to a dedicated,
disposable test database to run it without Docker:

```bash
cd backend
TEST_DATABASE_URL=postgresql+asyncpg://user:password@localhost/frontdashboard_test uv run pytest
```

When `TEST_DATABASE_URL` is unset, the database-backed tests fall back to a temporary Testcontainer
running `POSTGRES_IMAGE` (default `postgres:17-alpine`, the same variable `docker-compose.yml`
reads — dumps don't cross major versions, so the two are asserted equal in `test_config.py`). In both modes, Alembic builds the test schema and `tests/test_migrations.py` checks
it with `alembic check`, which catches missing/extra tables, columns, indexes, foreign keys, and
changed column types. It does **not** compare `server_default`s or CHECK constraints — those still
need asserting by hand.

`make test-unit` runs only the tests marked `unit`, which need neither PostgreSQL nor Docker.

**Never point `TEST_DATABASE_URL` at a development or production database** — the suite runs
migrations against it and some fixtures really commit and delete rows. This is enforced, not just
asked: the database name must end in `_test`/`-test` or start with `test_`, and the suite refuses
to start otherwise.

---

## Project Structure

```
frontdashboard/
├── backend/          # FastAPI app (Python)
├── frontend/         # React app (TypeScript)
├── docker-compose.yml
├── Caddyfile
└── .env.example
```

See [CONTEXT.md](CONTEXT.md) for current project state, the [ADRs](docs/adr/INDEX.md) / [FDRs](docs/fdr/INDEX.md) for architecture and feature decisions, and [docs/TODO.md](docs/TODO.md) for the open backlog.

---

## Contributing

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) format; the subject is normalized in `prepare-commit-msg` and enforced in `commit-msg`.
- Frontend dependency/security audits can be run with `make audit` or `cd frontend && npm run audit`.
- Suggested automatic fixes can be applied with `make audit-fix` or `cd frontend && npm run audit:fix`.
- Sole-contributor project: work is committed directly to `main` in logically grouped commits.
- CI (lint, tests, build) runs on every push and must stay green.
