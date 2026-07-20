.PHONY: dev-up dev-down logs test test-unit lint typecheck format audit audit-fix migrate seed hooks help

help:
	@echo ""
	@echo "  make dev-up    Start all services"
	@echo "  make dev-down  Stop all services"
	@echo "  make logs      Tail service logs"
	@echo "  make test      Run all tests"
	@echo "  make test-unit Run tests that need neither PostgreSQL nor Docker"
	@echo "  make lint      Lint backend + frontend (check only)"
	@echo "  make typecheck Run type checks for backend + frontend"
	@echo "  make format    Format + auto-fix backend and frontend"
	@echo "  make audit     Run dependency/security audit checks"
	@echo "  make audit-fix Apply npm audit fixes for frontend dependencies"
	@echo "  make migrate   Run Alembic migrations"
	@echo "  make seed      Seed development data"
	@echo "  make hooks     Install pre-commit hooks (via uv)"
	@echo ""

# Git hooks
hooks:
	uv tool install pre-commit
	pre-commit install --hook-type pre-commit --hook-type prepare-commit-msg --hook-type commit-msg --hook-type pre-push

# Docker
dev-up:
	docker compose up --build

dev-down:
	docker compose down

logs:
	docker compose logs -f

# Testing
test:
	cd backend && uv run pytest && uv run ty check
	cd frontend && npm run test:run

test-unit:
	cd backend && uv run pytest -m unit && uv run ty check
	cd frontend && npm run test:run

# Linting — check only, no modifications
lint:
	cd backend && uv run ruff check .
	cd backend && uv run deptry .
	cd frontend && npm run lint
	cd frontend && npm run knip

# Formatting — ruff format + lint fix for backend, Biome lint:fix for frontend
format:
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && npm run lint:fix

# Auditing — Frontend dependency/security checks
audit:
	cd frontend && npm run audit

audit-fix:
	cd frontend && npm run audit:fix

# Database
migrate:
	docker compose exec backend uv run alembic upgrade head

seed:
	@echo "TODO: implement in step 8"
