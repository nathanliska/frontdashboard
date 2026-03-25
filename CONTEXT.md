# FrontDashboard — Working Context

## Current Phase
**Step 6 of 19: Permissions service**

## Implementation Order (from PLAN.md §13)
- [x] 1. Repository + git setup
- [x] 2. Project scaffolding (Docker Compose, Caddy, FastAPI hello world, Vite hello world, .env.example)
- [x] 3. Database + migrations (Alembic, initial schema)
- [x] 4. Auth (registration, login, JWT cookies, refresh, CSRF, rate limiting)
- [x] 5. Group management (create group, invites, join/leave, roles)
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

## Step 6 Checklist
- [ ] `app/services/permissions.py` — permission-checking helpers used by routers

## Open Questions / Decisions Pending
- None currently
