.PHONY: dev-up dev-down logs test lint format migrate seed help

# Default target
help:
	@echo ""
	@echo "  make dev-up    Start all services (Docker Compose)"
	@echo "  make dev-down  Stop all services"
	@echo "  make logs      Tail service logs"
	@echo "  make test      Run all tests"
	@echo "  make lint      Lint backend + frontend"
	@echo "  make format    Format backend + frontend"
	@echo "  make migrate   Run Alembic migrations"
	@echo "  make seed      Seed development data"
	@echo ""

dev-up:
	@echo "TODO: implement in step 2 (scaffolding)"

dev-down:
	@echo "TODO: implement in step 2 (scaffolding)"

logs:
	@echo "TODO: implement in step 2 (scaffolding)"

test:
	@echo "TODO: implement once backend/frontend exist"

lint:
	@echo "TODO: implement once backend/frontend exist"

format:
	@echo "TODO: implement once backend/frontend exist"

migrate:
	@echo "TODO: implement in step 3 (database + migrations)"

seed:
	@echo "TODO: implement in step 3 (database + migrations)"
