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

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) format; the subject is normalized in `prepare-commit-msg` and enforced in `commit-msg`.
- No direct commits to `main`; branch protection enforces this in GitHub.
- All PRs must pass tests and lint before merge.
- See the [PR template](.github/pull_request_template.md) for the checklist.
