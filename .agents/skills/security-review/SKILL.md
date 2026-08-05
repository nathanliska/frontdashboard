---
name: "security-review"
description: "Whole-codebase security audit — parallel agents across auth, abuse, data exposure and serving, then an adversarial pass that verifies every finding against the source. Use when asked for a security review or audit, before exposing a new surface, or after a change to auth, sharing, SSE fan-out or the retention sweeps."
---

# Security Review

A full-codebase audit. For the pending changes on a branch, Claude Code's built-in
`/security-review` is the narrower tool — reach for this one when the question is about the whole
system rather than a diff.

Two rules override anything an agent decides on its own:

- **Read the source, never guess.** Every finding cites a path and line, and a finding whose cited
  line does not say what the finding claims is a false positive, not a rounding error.
- **No small-deployment discount.** See the exposure below. "Only a logged-in user can reach it" is
  not a mitigation when anyone can sign up.

## Exposure

Public on the internet, registration open to anyone holding a verifiable email, ~100 users and a few
concurrent, one backend worker, behind Cloudflare and Caddy. The product is household-shaped; the
deployment is not private. Abuse, enumeration and data-privacy findings are rated on that basis.

## Phase 1: Parallel Review Agents

Launch **4 agents in parallel** (Agent tool, `subagent_type: general-purpose`), one per surface.
Each reads actual source, cites `path:line`, rates Critical/High/Medium/Low/Info, gives a concrete
attack scenario and a suggested fix, and notes the patterns this codebase gets right.

### Agent 1: Authentication & Access Control

Session resolution and expiry, cookie flags and the `__Host-` prefix, CSRF double-submit and the
`Origin` check, Argon2 parameters, invite and password-reset token lifecycles, share grants and
role escalation, and IDOR anywhere a resource id arrives from the client.

The traps: `role is None` means **owner**, so an `if role:` guard silently grants nothing to the
creator or everything to a stranger — read `permissions.effective_role` before judging any caller.
Child resources must reach access through `load_dashboard_access` / `list_accessible_dashboard_ids`,
which filter trashed dashboards; a direct query on a child table bypasses that.

Key files: `backend/app/auth/`, `backend/app/services/permissions.py`,
`backend/app/services/shares.py`, `backend/app/services/sessions.py`,
`backend/app/services/invites.py`, `backend/app/services/password_reset.py`,
`backend/app/routers/`

### Agent 2: Input Validation, Enumeration & Abuse

Account enumeration through response bodies, status codes or timing on register, login, reset,
verification, invite and share-by-email; rate-limit coverage and whether the limit key can be
spoofed through proxy headers; unbounded queries, pagination ceilings and other DoS vectors; mass
assignment through request schemas; error messages that leak internals.

Every non-GET route needs `_csrf: None = Depends(require_csrf)` **and** `@limiter.limit(WRITE_LIMIT)`
with a `request: Request` parameter. A test catches the missing limit; nothing catches a route that
takes the CSRF dependency but validates the wrong thing. Beware any audit looping over `app.routes`
— slowapi's included-router nesting means it can pass having checked nothing.

Key files: `backend/app/routers/auth.py`, `backend/app/routers/invites.py`,
`backend/app/schemas/`, `backend/app/limiter.py`, `backend/app/middleware.py`,
`backend/app/config.py`

### Agent 3: Data Exposure & Lifecycle

SSE fan-out audience — who receives an event after a share is revoked, a dashboard is trashed, or a
user is deleted; the activity feed and notification staging; soft delete, the trash and the 30-day
reaper; retention sweeps; credentials or tokens reaching logs; metric labels carrying user data or
unbounded cardinality.

The traps: events are addressed with `dashboard_audience_user_ids(...)` and committed through
`commit_and_broadcast(...)` — an audience computed before a permission change is a leak to whoever
just lost access. A table with a `dashboard_id` or `users` foreign key that is missing from the
matching sweep in `services/retention.py` either outlives the purge or rolls back the whole tick,
because none of those FKs cascade.

Key files: `backend/app/sse/`, `backend/app/services/activity.py`,
`backend/app/services/notifications.py`, `backend/app/services/retention.py`,
`backend/app/metrics.py`, `backend/app/models/`

### Agent 4: Frontend & Serving

The `apiFetch` network boundary and `parseJson` validation, what a `401` versus a `403` is allowed
to do to session state, XSS through `dangerouslySetInnerHTML` or user-controlled URLs, open
redirects on post-auth navigation, anything sensitive reaching `localStorage` or the client bundle,
CSP and security headers, cache-control on the document versus hashed assets, and container
hardening.

The traps: only `401` means logged out — a `403`, `5xx`, timeout or network rejection that clears
the session is a denial-of-service on the user. Retries are GET-only. Session state lives in one
opaque cookie; a token in `localStorage` is a finding, not a style preference.

Key files: `frontend/src/api/http.ts`, `frontend/src/api/client.ts`,
`frontend/src/stores/auth.ts`, `frontend/src/hooks/useSSE.ts`, `Caddyfile.prod`,
`frontend/Dockerfile.prod`, `backend/Dockerfile.prod`, `docker-compose.prod.yml`

## Phase 2: Compile

Deduplicate into one report in the session scratchpad — **not** in the repo, which ignores no
scratch directory. Group by severity and mark anything two agents found independently; agreement
across surfaces is the strongest signal available before verification.

## Phase 3: Adversarial Verification

Launch **one** agent that does not trust the previous four. It re-reads the source at every cited
line and rates each finding **CONFIRMED**, **CONFIRMED-DOWNGRADE**, **CONFIRMED-UPGRADE**, **FALSE
POSITIVE** or **NEEDS-MORE-INVESTIGATION**, then adds what the others missed. Direct it at:

- Mitigations the auditors did not see — a dependency, middleware, or a database constraint.
- The known good patterns below, which are design, not defects.
- Permission edge cases at the owner/editor/viewer boundary, especially `role is None`.
- Ordering: an event built after its commit, or an audience computed before a permission change.
- Anything reachable before authentication, weighed against open registration.

## Phase 4: Report

Summary table with final severities, then a fix order that puts quick wins first. Confirmed findings
append to [docs/TODO.md](../../../docs/TODO.md) with the next free number, per its own maintenance
rule — that file is the backlog, and a finding that lives only in a report is a finding that gets
lost. Say plainly which surfaces were audited thinly or not at all.

## Known Good Patterns

Design decisions, not vulnerabilities. A finding that contradicts one of these needs to argue with
the ADR, not merely observe the behavior:

- `/shares` on lists and calendar events returns **409 by design** — those inherit access from the
  dashboard whose widget binds them. It is a deliberate stub, not a missing endpoint.
- `role is None` is the **owner**, the most privileged case.
- One opaque session cookie resolved per request; no JWT, no refresh token, no `/auth/refresh`, no
  tokens in `localStorage` ([ADR-002](../../../docs/adr/ADR-002-jwt-httponly-cookies-csrf.md),
  [ADR-003](../../../docs/adr/ADR-003-first-class-sessions.md)).
- Registration is open to anyone with a verifiable email. Enumeration and abuse findings still
  stand; "unauthenticated users can register" on its own does not.
- SSE is one multiplexed stream per open tab, fanned out by user — three tabs are three streams.
- There is no archive state; DELETE puts a dashboard or list in the trash for 30 days
  ([ADR-007](../../../docs/adr/ADR-007-soft-delete-boundary.md)).
- Argon2 runs at its **minimum** cost under test. The real profile is ~64 MiB and four threads; take
  the `production_argon2` fixture before concluding the parameters are weak.
