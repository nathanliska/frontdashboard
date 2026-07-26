# ADR-017: Google Calendar Two-Way Sync (Per-User OAuth)

**Date:** 2026-07-25

**Status:** Accepted (design) — not yet implemented. This records the shape of the decision so the
foundation isn't built into a corner. Fill in the behavioral detail as an FDR (extending
[FDR-006](../fdr/FDR-006-calendar-and-events.md)) when it ships.

## Context

Users want FrontDashboard calendar events to appear in — and stay in step with — their own Google
Calendar, and vice versa. This is the app's **first external-service integration**: today everything
is first-party (own Postgres, cookie+CSRF auth, no third-party HTTP client, no OAuth). Introducing it
adds architectural surface the app has never had — outbound OAuth, long-lived third-party tokens, and
a background pipeline that reacts to changes originating outside the app.

Key forces:

- **Whose account:** each user links **their own** Google account (per-user tokens), not a shared
  household account.
- **Direction:** **two-way**. Edits on either side propagate to the other.
- **Recurrence mismatch:** FD has a hand-rolled recurrence engine + `CalendarEventOverride`; Google
  speaks iCal RRULE. The two must be reconciled.
- **Self-hosting:** every deployment is operated by a household admin, so credential setup burden and
  publicly-reachable endpoints are real constraints (though the app already sits behind Cloudflare).

## Decision

Build **two-way, per-user Google Calendar sync** with these choices:

- **Per-user OAuth tokens.** Each user authorizes their own Google account; store their access/refresh
  tokens (encrypted) keyed to the user. Model the storage on the existing refresh-token pattern.
- **Deployment-level OAuth client credentials.** The admin creates one Google Cloud OAuth app and
  supplies `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` via env; all users on that instance link their
  own accounts through it. (Rejected: per-user Google Cloud apps — brutal setup burden per person.)
- **User picks which dashboards sync.** Each selected dashboard maps to a Google calendar, rather than
  syncing everything the user can see. Gives control over what leaves the app.
- **Sync-token incremental fetch is the core; webhooks + slow polling layer on top.** Google push
  notifications only say "something changed" — the actual delta always comes from `events.list` with a
  stored `syncToken`, so that machinery is mandatory either way. Webhooks provide near-instant updates;
  a slow (~15–30 min) poll is the self-healing safety net that catches missed notifications and renews
  expiring push channels (~7-day lifetime). The sync-token core can ship first, webhooks/fallback after.
- **Last-write-wins by modification timestamp** for conflicts (same event edited both sides between
  syncs). Both systems expose an updated-at; most recent wins.
- **Translate recurrence rules both ways.** Map FD's recurrence JSON ↔ RRULE and FD overrides ↔ Google
  occurrence exceptions, preserving series natively on both sides. (Rejected: expanding a series into
  standalone Google events — loses "edit all future," explodes event counts.)

## Consequences

- **New architectural surface, first of its kind:** outbound OAuth flow, encrypted long-lived token
  storage + refresh, and a background sync service — none of which the app has today. This is the
  precedent-setting integration; later external integrations should follow its patterns.
- **Requires a public callback + webhook endpoint and a scheduler.** Callback and push-notification
  endpoints must be reachable (fine behind Cloudflare) and secured; channel renewal and the polling
  fallback need a background job runner the app doesn't yet have.
- **Recurrence translation is the main correctness risk.** FD ↔ RRULE is lossy at the edges; overrides,
  moved occurrences, and cancellations are where bugs will concentrate. Worth heavy test coverage.
- **Self-hoster setup burden:** each deployment needs its own Google Cloud OAuth app and consent-screen
  configuration. Documented as a one-time admin step; no way around it for the full Calendar API.
- **Phasing is safe:** the sync-token core (and even a one-way FD→Google mirror) is a strict subset, so
  it can ship first without rework. Two-way, webhooks, and the polling fallback layer on cleanly.
- **Interacts with existing invariants:** synced events still flow through SSE (ADR-004/ADR-015) to
  other FD clients, and access is still governed per-dashboard (ADR-001) — a user only syncs events on
  dashboards they can see.
