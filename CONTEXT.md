# FrontDashboard — Current State

> **This is a CURRENT-STATE doc, not a changelog.** When a feature lands, fold its *current
> behavior* into the right section below; don't append dated entries. Remove what no longer
> exists. It says *what* is built: the reasons live in the linked
> [ADRs](docs/adr/INDEX.md) and [FDRs](docs/fdr/INDEX.md), and open remediation work in
> [docs/TODO.md](docs/TODO.md).

_Last updated: 2026-11-13_

## What's built

**Auth & account** — [FDR-001](docs/fdr/FDR-001-authentication-and-sessions.md)
- Registration → email verification (required before login) → one opaque session cookie
  (HttpOnly), guarded by an `Origin` check plus CSRF double-submit
  ([ADR-002](docs/adr/ADR-002-httponly-cookie-csrf.md)). No access/refresh split.
- **Sessions are the entire credential**: one `sessions` row per login holding the SHA-256 of the
  cookie's token, resolved on every request, so revocation is immediate. An idle window (7d, slid
  per request) and an absolute one (30d from login) bound it. Password change revokes every
  *other* session ([ADR-003](docs/adr/ADR-003-first-class-sessions.md)).
- **Email identity is case-insensitive** (normalized at the API boundary, `lower(email)` unique
  index). Display names are trimmed, non-empty, ≤100 chars.
- Password reset by email; authenticated password change, profile rename and **change of email**,
  confirmed from the new inbox and announced to the old (§8). Every auth endpoint is rate-limited.
- **An account can delete itself**, against the password: own dashboards are purged, memberships
  and sessions go, and the `users` row stays as a "Deleted user" tombstone so shared content keeps
  its author. Refused while they own a dashboard others can see (§7).
- New passwords are screened against a common-password list at registration, reset and change —
  length alone let `password123` through. Throwaway-inbox addresses are refused at registration
  and email change; privacy relays are not (§9).
- **A link that changes who you are says so first.** The reset page checks its token before
  offering a form, without consuming it; a verification link opened while signed in asks before
  switching accounts. A resent verification link keeps the earlier ones working, and verifying
  through any of them spends the rest (§10).
- **No endpoint reveals whether an account exists** — login, registration, reset and
  resend-verification answer identically for known and unknown addresses, in response and in
  timing ([ADR-011](docs/adr/ADR-011-enumeration-safe-login.md), §11).
- **Argon2 runs off the event loop** under a bounded limiter (`argon2_max_concurrency`, default 4)
  ([ADR-010](docs/adr/ADR-010-argon2-off-event-loop.md)).
- Emails send via Resend in background tasks. Without an API key, development writes the rendered
  message to the gitignored `backend/.dev-mail/` outbox and logs only the file path; any other
  environment logs that the mail was dropped. HTML templates exist for all three flows.
- The sign-in and register pages share a pitch panel beside the form saying what the app is.
- Profile page: display name, password change, home-dashboard preference, and a paged
  active-session panel titled by browser and platform; another session can be revoked from it,
  and refresh is explicit.
- **Client state resets at every auth boundary**, and a session-generation counter drops any
  in-flight response from the previous account
  ([ADR-012](docs/adr/ADR-012-session-generation-guard.md)). Only a 401 means signed out; an
  unreachable server shows a retry.

**Dashboards & widgets** — [FDR-002](docs/fdr/FDR-002-dashboards-and-layout.md),
[FDR-003](docs/fdr/FDR-003-widgets.md)
- Multiple dashboards per user; a default "My Dashboard" is created on registration. The listing
  page has favorites, a create modal and a **Trash** view: delete moves a dashboard and its lists
  and events to the owner's trash, restorable for 30 days or from **Undo** on the toast, then
  purged by the retention reaper ([ADR-007](docs/adr/ADR-007-soft-delete-boundary.md)).
- Editor: react-grid-layout drag/resize, saved with an optimistic version. A 409 is resolved in the
  client — re-read, replay the gesture, retry once — and only a second one raises the conflict
  banner ([ADR-008](docs/adr/ADR-008-layout-version-occ.md)). Saves are serialized and coalesced,
  so rapid gestures cannot conflict with themselves.
- **The canonical grid is 24 x 24 and both axes are hard bounds**: a board is one screen, and
  nothing — drag, resize, collision push or server placement — may leave it. Overlap and
  out-of-bounds are rejected on the write path. A new widget takes the first free slot at up to
  its default size, never below its type minimum (4×4, or 8×8 for calendar); no usable gap is a
  409 ([ADR-009](docs/adr/ADR-009-canonical-layout-mobile-projection.md)).
- **The stacked view is a derived projection.** Below 960px of board the grid renders a read-only
  one-column stack, each widget capped under one phone screen; it can never be written back.
- **Dashboard mutations share one success/failure contract**: store actions never throw, and
  dialogs close only on a truthy result, so a failed write keeps the user's input.
- Widget types: **list** (bind existing or auto-create), **clock**, **calendar**, **agenda**
  (today/overdue/upcoming). A widget config change patches other tabs in place rather than
  reloading them.
- Calendar cells (widget and page) fill the pill rows they have room for and put "+N" on the
  date's line; the month grid never scrolls, and below 460px the week view lists one row per day.

**Sharing** — [FDR-004](docs/fdr/FDR-004-sharing-and-access.md)
- Dashboards are shared by **single-use invite link** carrying viewer/editor; owner = creator.
  There is no user search and no direct grant — every grant is a redeemed invite. Codes are stored
  hashed, expire, are shown once and can be revoked while unused; accepting is a separate POST.
- Lists and calendar events inherit access from the dashboard that binds them.
- A member can **leave** a shared dashboard. The owner cannot; their exits are deleting it or
  **handing it to a member**, after which they stay on as an editor.

**Lists** — [FDR-005](docs/fdr/FDR-005-lists.md)
- Master/detail UI with nested routes and mobile slide nav; items carry check, due date, priority,
  category, assignee and a manual sort order, which is the only stored order.
- Deleting a list moves it to the trash (30 days, restorable; the sidebar's **Active/Trash**
  selector lists it). Deleting an item removes the row outright.
- **Drag-and-drop reorder** of items and of lists, with keyboard support, through two
  transactional renumber endpoints that 409 unless the submitted id set matches exactly. The
  dashboard list widget is deliberately not reorderable.
- **Checked pile**: checked items collect in a collapsible "Checked (N)" pile, display-only, so
  unchecking returns an item to its place. The add box dedupes against the pile — typing a checked
  item's name unchecks it; Escape dismisses the suggestion when a duplicate is wanted.
- **A dashboard's lists load in one request** (`GET /lists/details`), shared by its list and
  agenda widgets.
- **List events carry their new state** — reorder, item check/update, item create and item delete
  — so another client patches its cache with no follow-up GET. A client that does not hold the
  list, or holds it stale, reads instead ([ADR-006](docs/adr/ADR-006-rest-fetch-sse-patch.md)).

**Calendar** — [FDR-006](docs/fdr/FDR-006-calendar-and-events.md)
- Day/week/month views; a full event editor with weekly recurrence, all-day, timezones, and
  per-occurrence overrides and cancellation.
- Occurrences are expanded over a required window (max 366 days), which is a SQL predicate: a
  finished or not-yet-started series never reaches Python, though one bounded by `count` alone
  still loads. Expansion is budgeted twice: a single event past the budget is left out and
  counted, and a whole listing past its budget answers 422 rather than truncating.
- Occurrences are cached by covered interval per dashboard, so the page and both widgets share one
  copy and fetch only the gaps.
- **Delete is undoable, then recoverable**: Restore on the toast, then a Trash view with Restore
  and Delete permanently.
- **Participants**: an event can name the members it is about — a label only, with no
  notification or access change. A member who leaves stays named as "(former)".
- **Day-dependent views refresh at local midnight** and on tab wake (`useLocalDay()`).

**Notifications & activity** — [FDR-007](docs/fdr/FDR-007-notifications-and-activity.md)
- In-app inbox (unread-first, mark one/all read) with live push.
- Activity feed of the caller's own events, keyset-paginated, filterable by category or event
  type. Repetitive churn collapses into one expandable row. A live append is gated on the same
  predicate the endpoint serves.

**Real-time (SSE)** — [FDR-008](docs/fdr/FDR-008-realtime-sse.md)
- One multiplexed `EventSource('/api/sse')` per tab, fanned out by user, with per-tab echo
  suppression ([ADR-004](docs/adr/ADR-004-sse-over-websocket.md)). Fan-out reaches other processes
  over a Valkey stream.
- A reconnect hands back the activity log's high-water mark and is resynced only if the log moved
  past it. A resync names which entity types changed, so the client refetches only those.
- A client whose queue overflows keeps its stream; the backlog collapses into one `resync`.
- A stream rejected with an HTTP error reconnects on jittered backoff (1s → 30s) and never logs
  anyone out; every fourth attempt probes `/auth/me`.
- An amber dot on the account avatar and the mobile navigation button shows a degraded stream, and
  only then. There is no presence feature.
- Streams revalidate their session every 30s and end when it is revoked.

**UI primitives & accessibility**
- All modals share one Radix-based `ui/Dialog`, and the confirm dialog takes `confirmLabel` and
  `tone` so its button names the action. The notification panel is a Radix Popover; row
  actions live in a visible overflow menu (≥44px target) and hover-revealed actions also reveal
  on keyboard focus. Toasts announce through a persistent `role="status"` live region.
- **Validation is attached to the field that failed**, not toasted: `ui/FormField` wires
  `aria-invalid` and `aria-describedby` to a `role="alert"` message, so it is announced on submit
  and again when focus reaches the control, and persists until fixed rather than expiring on a
  toast timer. Inline editors validate in the editor for the same reason. Multi-field forms mark
  every failing field at once.

**Client data layer** — [ADR-005](docs/adr/ADR-005-two-layer-client-state.md)
- Zustand stores for app and session state; `createScopedQuery` resource caches for lists,
  calendar and agenda. Caches keep the 32 most recently fetched scopes and never evict one that
  is mounted or in flight.
- A mutation's response is applied, never refetched.
- Resource caches register their own sign-out reset; `stores/auth.ts` calls one
  `resetAllResourceData()`.
- **The backend schema is the API contract**: `make contracts` generates the frontend's zod
  schemas, CI fails on drift, and every response body and SSE frame is validated at the boundary
  ([ADR-018](docs/adr/ADR-018-generated-validated-contracts.md)).

**Infra / tooling**
- Docker Compose dev + prod; Caddy in prod behind a Cloudflare Tunnel; named volumes; health
  checks. Valkey is bundled on the internal network with no published port.
- **Scale is by replica; the container runs one worker.** Forked workers share a socket, so one
  `/metrics` scrape reaches an arbitrary one and every counter reads as resetting.
  `WEB_CONCURRENCY` is inert and logs a warning. Rate-limit buckets and the SSE backplane are
  shared in Valkey; what remains is routing — `container_name` and a static Caddy upstream, so
  `--scale` is refused rather than half-working. Migrations run in the container command under a
  session-scoped advisory lock, which serialises replicas starting together.
- **Metrics at `/metrics`, outside `/api`**, which is the access control: Caddy proxies only
  `/api/*` and the backend publishes no port. Dashboards, alert rules and the reasoning behind
  each series are in [observability/README.md](observability/README.md).
- **The access log is real traffic only**: successful health and metrics probes are filtered out
  at `info`; a failing probe always logs.
- **Liveness and readiness are separate.** `GET /api/health` touches nothing, so a dependency
  outage can never look like a crashed process. `GET /api/health/ready` runs a bounded `SELECT 1`
  and returns 503 when the database is unreachable, hung, or the pool is exhausted; the container
  healthcheck uses it.
- **The frontend waits for the backend to start, not to be healthy** — Caddy resolves its
  upstream per request, so a restart serves the shell plus a 502 on `/api` instead of nothing.
- **A failed load is visible rather than blank**: `index.html` is `no-cache`, a missing asset
  404s instead of falling back to HTML, and an unknown URL renders a 404 page
  ([ADR-019](docs/adr/ADR-019-static-asset-serving-contract.md)).
- **Both production images run unprivileged** (uid 10001); Caddy holds no Linux capability, and
  `:80` binds because the compose files set `net.ipv4.ip_unprivileged_port_start` to 0 explicitly
  rather than inheriting it, so the port the tunnel points at never had to move. CI asserts both
  images are non-root. Base
  images float on their tags and every CI build passes `pull: true`, so a rebuild takes security
  patches — not pinned by digest, because nothing sends digest-only bumps and a rollback pulls a
  published image rather than rebuilding. `uv` keeps a version
  tag, since a resolver change should arrive as a reviewable bump.
- **A scheduled reaper bounds every table that grows on its own**: expired tokens, invites and
  sessions; activity events and notifications past 90 days; trashed rows past 30 days; and
  unverified signups past 30 days that own no content. It runs under a Postgres advisory lock, so
  exactly one process sweeps.
- **The connection pool is bounded** (10 connections), with an acquire timeout, recycling and a
  server-side `statement_timeout`, so a burst fails fast. All of it is config.
- **Production config fails fast**: `ENVIRONMENT` is a required enum, and startup aborts on a
  missing mail key or an undeliverable sender
  ([ADR-014](docs/adr/ADR-014-fail-fast-prod-config.md)).
- **Every mutating route is rate-limited** (`WRITE_LIMIT`, 300/min) per real client IP
  (`CF-Connecting-IP`), with buckets
  in Valkey and a per-process fallback while it is unreachable; Caddy caps bodies at 1MB
  ([ADR-013](docs/adr/ADR-013-rate-limit-cf-connecting-ip.md)).
- **Per-creator quotas bound the total** of dashboards, lists, items and events, checked on
  create and counting trashed rows; the trash view's permanent delete reclaims the allowance.
  Refusals are visible as `frontdashboard_quota_rejections_total`
  ([ADR-020](docs/adr/ADR-020-resource-quotas.md)).
- **CI** is four grouped jobs, each with a tight `timeout-minutes`, because Actions bills each
  job rounded up to a full minute and ten small lanes cost double their compute: repo
  checks (workflow lint, prod Compose structure, alert rules, dependency audit, contract drift,
  and the six cross-stack source guards), backend, frontend, and **images & smoke**, which boots
  both production images against a throwaway database, layered over the real prod Compose file so
  a drift from the Caddy upstream fails there, and asserts the serving contract.
  Publishing images is gated on all of it — there is no path that builds and pushes without
  passing them first. Docs-only changes skip the workflow.
- Backend tests build their schema with `alembic upgrade head`, so migrations run on every
  backend test run; `make test-unit` is the Docker-free subset.
- Dependabot is grouped and monthly, majors included: weekly churn was noise, and batching keeps
  upgrades incremental.

## In flight

- The remediation backlog — infra/CI/ops and unscheduled triage — is tracked in
  [docs/TODO.md](docs/TODO.md), not here.

## Deliberately deferred / known dead code

- `CalendarReminder` model + table exist with **no** router/service usage — reserved schema for a
  future "notify me N minutes before" feature, kept deliberately
  ([FDR-006](docs/fdr/FDR-006-calendar-and-events.md)), not dead code to remove.
- Share principal types other than `user`, and share roles beyond viewer/editor, are
  intentionally not built.
