.PHONY: dev-up dev-down logs test lint format migrate seed help

help:
	@echo ""
	@echo "  make dev-up    Start all services"
	@echo "  make dev-down  Stop all services"
	@echo "  make logs      Tail service logs"
	@echo "  make test      Run all tests"
	@echo "  make lint      Lint backend + frontend (check only)"
	@echo "  make format    Format + auto-fix backend and frontend"
	@echo "  make migrate   Run Alembic migrations"
	@echo "  make seed      Seed development data"
	@echo ""

# Docker
dev-up:
	docker compose up --build

dev-down:
	docker compose down

logs:
	docker compose logs -f

# Testing
test:
	cd backend && uv run pytest -q
	cd frontend && npm run test:run

# Linting — check only, no modifications
lint:
	cd backend && uv run ruff check .
	cd frontend && npm run lint

# Formatting — ruff format + lint fix for backend, Prettier + ESLint fix for frontend
format:
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && npm run format && npm run lint -- --fix

# Database
migrate:
	docker compose exec backend uv run alembic upgrade head

seed:
	@echo "TODO: implement in step 8"
