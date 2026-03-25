# FrontDashboard — Working Context

## Current Phase
**Step 1 of 19: Repository + git setup** (in progress)

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

## Step 1 Checklist
- [x] Git repo initialized
- [x] GitHub remote set
- [x] .gitignore
- [x] .pre-commit-config.yaml (ruff + pre-commit-hooks; Husky added in step 2 when frontend exists)
- [x] .githooks/commit-msg (conventional commits)
- [ ] .githooks/pre-push (run unit tests)
- [ ] PR template (.github/pull_request_template.md)
- [ ] Issue templates (.github/ISSUE_TEMPLATE/)
- [ ] README skeleton
- [ ] Makefile with placeholder targets
- [ ] git config core.hooksPath .githooks
- [ ] Initial commit + push

## Action Items
- Run `git config core.hooksPath .githooks` after setup
- Add GitHub username to README links (placeholder currently used)
- Step 2 kicks off Docker Compose + scaffolding

## Open Questions / Decisions Pending
- None currently
