# FrontDashboard — Working Context

## Current Phase
**Step 2 of 19: Project scaffolding**

## Implementation Order (from PLAN.md §13)
- [x] 1. Repository + git setup
- [ ] 2. Project scaffolding (Docker Compose, Caddy, FastAPI hello world, Vite hello world, .env.example)
- [ ] 3. Database + migrations (Alembic, initial schema)
- [ ] 4. Auth (registration, login, JWT cookies, refresh, CSRF, rate limiting)
- [ ] 5. Group management (create group, invites, join/leave, roles)
- [ ] 6. Permissions service
- [ ] 7. Sidebar layout
- [ ] 8. Lists module (backend)
- [ ] 9. Lists module (frontend)
- [ ] 10. Activity events
- [ ] 11. SSE infrastructure
- [ ] 12. Real-time list sync
- [ ] 13. Notifications
- [ ] 14. Dashboard system
- [ ] 15. Private dashboard
- [ ] 16. Group dashboards page
- [ ] 17. List widget
- [ ] 18. Additional widgets (clock, welcome/status)
- [ ] 19. Polish

## Step 2 Checklist
- [ ] `backend/` — FastAPI hello world, uv project, Ruff configured in pyproject.toml, Dockerfile
- [ ] `frontend/` — Vite + React + TypeScript hello world, ESLint + Prettier configured, Dockerfile
- [ ] `docker-compose.yml` — caddy, frontend, backend, db services
- [ ] `Caddyfile` — reverse proxy, SSE passthrough, security headers
- [ ] `.env.example` — all required vars documented
- [ ] Populate Makefile targets (dev-up, dev-down, logs, lint, format)
- [ ] Husky pre-commit hook wired up in frontend
- [ ] `make dev-up` boots all four services cleanly

## Action Items
- Run `git config core.hooksPath .githooks && chmod +x .githooks/*` if not already done

## Open Questions / Decisions Pending
- None currently
