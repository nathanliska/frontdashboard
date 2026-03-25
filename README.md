# FrontDashboard

A self-hosted dashboard app that acts as a private household operating system. Shared where coordination matters, private where personal space matters, modular in layout and features.

---

## Features (v1.0)

- **Private dashboard** — personal cockpit with customizable widget layout
- **Group dashboards** — shared coordination surface for households, roommates, etc.
- **Lists** — checklists, grocery lists, and todos with real-time sync
- **Real-time updates** — SSE-based live sync across all connected members
- **Notifications** — in-app bell with inbox and activity history
- **Invite system** — reusable invite codes to add group members

---

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.12+, FastAPI, SQLAlchemy 2.0, Alembic, PostgreSQL 16 |
| Frontend | React 18+, TypeScript, Vite, Tailwind CSS, Zustand, react-grid-layout |
| Infra | Docker Compose, Caddy |

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

# 2. Configure git hooks
git config core.hooksPath .githooks
chmod +x .githooks/*

# 3. Copy and fill in environment variables
cp .env.example .env

# 4. Install pre-commit hooks (backend linting)
pip install pre-commit
pre-commit install

# 5. Start all services
make dev-up
```

The app will be available at `http://localhost`.

---

## Development

```bash
make dev-up      # Start all services (Docker Compose)
make dev-down    # Stop all services
make test        # Run all tests
make lint        # Lint backend + frontend
make format      # Format backend + frontend
make migrate     # Run Alembic migrations
make seed        # Seed development data
make logs        # Tail service logs
```

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

See [PLAN.md](PLAN.md) for full architecture documentation.

---

## Contributing

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) format, enforced by the `commit-msg` hook.
- No direct commits to `main`.
- All PRs must pass tests and lint before merge.
- See the [PR template](.github/pull_request_template.md) for the checklist.
