# FrontDashboard — Current State

> **This is a CURRENT-STATE doc, not a changelog.** When a feature lands, fold its *current
> behavior* into the right section below; don't append dated entries. Remove what no longer
> exists. Live remediation status lives in `docs/references/review-findings.md`.

_Last updated: 2026-07-16_

## What's built

**Auth & account**
- Registration → email verification (required before login) → JWT session in HttpOnly cookies
  with CSRF double-submit; single-use rotating refresh tokens (7d) + 15-min access tokens.
- Password reset via email (revokes all refresh tokens); authenticated password change and
  profile rename (both re-issue the access cookie). Rate limits on all auth endpoints.
- Emails send via Resend in background tasks; without an API key the sender logs the link
  (how you get tokens locally). HTML templates exist for both flows.
- Profile page: display name, password change, home-dashboard preference.

**Dashboards & widgets**
- Multiple dashboards per user; default "My Dashboard" created on registration. Listing page
  with favorites, create modal, archive (badge + section + editor banner), hard delete (also
  removes owned lists/items/events/widgets/shares).
- Editor: react-grid-layout drag/resize, debounced saves with optimistic version → 409
  conflict banner + reload resolution; settings modal (rename/archive/share).
- Widget types: **list** (bind existing or auto-create), **clock**, **calendar**, **agenda**
  (today/overdue/upcoming). Add-widget wizard picks type → resource where applicable.

**Sharing** (groups feature was removed — per-resource shares replaced it)
- Dashboards are shared directly with users (search by name/email) as viewer/editor; owner =
  creator. Lists and calendar events inherit access from the dashboard that binds them; their
  `/shares` endpoints are deliberate 409 stubs. Share/unshare and archiving notify affected
  users and clean up their preferences.

**Lists**
- Master/detail lists UI with nested routes + mobile slide nav; items support check, due date,
  priority, category, assignee, manual sort order. Lists must be archived before delete (409
  otherwise); delete cleans up bound widgets and shares. Soft delete throughout.
- **Drag-and-drop reorder** (dnd-kit) of items within a list and of lists in the sidebar, via
  drag handles with keyboard support. Order persists through two transactional endpoints
  (`PUT /lists/{id}/items/order`, `PUT /lists/order`) that renumber `sort_order` to `0..n-1`
  under a row lock and require the submitted id set to match exactly (409 otherwise); DB CHECK
  constraints keep `sort_order` nonnegative. Checked items stay in place — manual order is the
  only order. New lists append last.
- The sidebar has an **Active/Archived** selector: Active is the default and is reorderable;
  archived lists are viewable but not reorderable (the server renumbers only non-archived
  lists, so the submitted set must equal that set). The dashboard `ListWidget` is deliberately
  not reorderable — it sits inside react-grid-layout, whose own drag would conflict.
- Reorder SSE events carry the new id order, so other clients patch their cache in place with
  no follow-up GET (one refetch only if the payload diverges from cache). Other list events
  still invalidate-and-refetch — see `docs/designs/sse-hardening-design.md`.

**Calendar**
- Day/week/month views; full event editor (mobile-optimized) with weekly recurrence, duration
  toolbar, all-day, timezones; per-occurrence overrides and cancellation. Occurrence expansion
  over a required window (max 366 days).

**Notifications & activity**
- In-app inbox (unread-first, mark one/all read) with live SSE push; activity feed of the
  caller's own events, keyset-paginated, hiding noisy event types by default.

**Real-time (SSE)**
- One multiplexed `EventSource('/api/sse')` per user; in-memory manager with bounded queues,
  `connected` priming event, `resync` on reconnect with `Last-Event-ID`. Frontend routes
  events to Zustand stores / scoped-query resource caches with client-mutation-id echo
  suppression.

**Infra / tooling**
- Docker Compose dev + prod, Caddy in prod (behind Cloudflare), named volumes, health checks.
- CI: lint (Ruff/Biome), tests (pytest via Testcontainers, Vitest), `ty` type check, frontend
  build. Pre-commit hooks incl. Conventional Commit enforcement. Dependabot grouped/monthly.

## In flight

- **Design-review remediation** (see the live tracker in
  `docs/references/review-findings.md`): Phase 1 (security quick wins #3/#4/#5) shipped
  2026-07-12. **Phase 2 — auth/session hardening (#1, #6, #7, #8, #13, #31) is next**; no
  spec/plan written yet.

## Deliberately deferred / known dead code

- Review-findings backlog phases 3–6 + unscheduled triage bucket — tracked in the rollout
  table, not here.
- `CalendarReminder` model + table exist with **no** router/service usage (vestigial; slated
  for a decision when calendar work resumes).
- `EventType.membership_*` values are vestiges of the removed groups feature.
- Share principal types other than `user`, and share roles beyond viewer/editor, are
  intentionally not built.
