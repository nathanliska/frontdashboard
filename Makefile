.PHONY: dev-up dev-down logs test lint format migrate seed help

help:
	@echo ""
	@echo "  make dev-up    Start all services"
	@echo "  make dev-down  Stop all services"
	@echo "  make logs      Tail service logs"
	@echo "  make test      Run all tests"
	@echo "  make lint      Lint backend + frontend"
	@echo "  make format    Format backend + frontend"
	@echo "  make migrate   Run Alembic migrations"
	@echo "  make seed      Seed development data"
	@echo ""

dev-up:
	docker compose up --build

dev-down:
	docker compose down

logs:
	docker compose logs -f

test:
	cd backend && uv run pytest -q
	cd frontend && npm run test:run

lint:
	cd backend && uv run ruff check .
	cd frontend && npm run lint

format:
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && npm run format

migrate:
	docker compose exec backend uv run alembic upgrade head

seed:
	@echo "TODO: implement in step 3"
