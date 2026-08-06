# FrontDashboard — Current State

> **This is a CURRENT-STATE doc, not a changelog.** When a feature lands, fold its *current
> behavior* into the right section below; don't append dated entries. Remove what no longer
> exists. Open remediation work lives in [docs/TODO.md](docs/TODO.md).

_Last updated: 2026-08-05_

## What's built

**Auth & account**
- Registration → email verification (required before login) → an opaque session cookie
  (HttpOnly) guarded by an `Origin` check plus CSRF double-submit. One credential, no
  access/refresh split.
- **Email identity is case-insensitive**: addresses are normalized (trim + lowercase) at the API
  boundary and a `lower(email)` functional unique index is the DB guarantee, so casing can't create
  duplicate accounts or block login. Display names are bounded (trimmed, non-empty, ≤100 chars).
- **Sessions are first-class, and are the entire credential**: one `sessions` row per login
  holding the SHA-256 of the opaque token in the `session` cookie. Every request resolves that row,
  so revocation is immediate. Two clocks bound it, both server-side: an **idle** window
  (`last_used_at`, 7d) slid on each request by the auth dependency, and an **absolute** one
  (`expires_at`, 30d) fixed at login. Password change revokes every *other* session and keeps
  yours; reset and logout revoke accordingly.
- The access/refresh split was removed 2026-07-28 ([ADR-003](docs/adr/ADR-003-first-class-sessions.md)).
  It bought nothing — the per-request session check already made revocation immediate, so a short
  token expiry bounded nothing — while costing a mandatory `/auth/refresh` round trip whose
  failure during a deploy signed users out, and reuse detection that read a *lost response* as
  theft. Both were observed in production. The trade taken knowingly: no theft detection.
- Password reset via email; authenticated password change and profile rename. Rate limits on all
  auth endpoints.
- **A link that changes who you are says so first.** The reset page checks its token before
  offering a form (`POST /auth/password-reset/check`, which reports validity only and never
  consumes), so a dead, spent or unknown link says so instead of failing after a password is
  typed twice; a signed-in visitor is warned the link may not be theirs, without naming its owner.
  A verification link opened while signed in asks before switching accounts.
- **No endpoint reveals whether an account exists.** Login, registration, password reset and
  resend-verification all answer identically for known and unknown addresses, and registration pays
  an Argon2 hash either way so timing doesn't leak what the response won't. Signing up with an
  address that already has an account creates nothing and emails the owner instead. See ADR-011.
- **Password hashing is Argon2, run off the event loop**: `hash_password`/`verify_password` execute
  in a worker thread via `anyio.to_thread.run_sync` under a shared, bounded capacity limiter
  (`argon2_max_concurrency`, default 4), so an auth burst can't stall the event loop or exhaust
  memory. **Login is enumeration-safe**: it always pays exactly one Argon2 verify (against a fixed
  dummy hash when the email is unknown) and returns an identical 401 whether the account is missing
  or the password is wrong — no timing side-channel.
- Emails send via Resend in background tasks. Without an API key, **development** writes the
  rendered message to a gitignored `backend/.dev-mail/` outbox (how you get tokens locally) and logs
  only the file path — the links are bearer credentials, so they stay out of the log stream; any
  other environment logs that the mail was dropped. HTML templates exist for all three flows.
- Profile page: display name, password change, home-dashboard preference.
- **Client state resets at every auth boundary** (login, logout, email verification, unauthenticated
  startup): notifications, resource caches, and the dashboard store (fields, in-flight request
  machinery, pending mutations) are all cleared. A shared session-generation counter guards every
  async write in the **dashboard, auth, and notifications** stores — each captures the generation at
  entry and drops its post-await write if a boundary crossed — so a prior account's in-flight response
  can't repopulate the next account's state (dashboards, `user`, or notifications) in the same tab.
  Logout tears down the session view and SSE stream before its network round-trip.

**Dashboards & widgets**
- Multiple dashboards per user; default "My Dashboard" created on registration. Listing page
  with favorites, a create modal, and a **Trash** view (#40): delete moves the dashboard (with its
  lists/events) to the owner's trash, restorable for 30 days with the deadline shown; the retention
  reaper then purges the full cascade. Restore brings shares and children back intact. **Archive was
  removed (2026-07-27)** — trash is the only put-away state, for dashboards and lists alike.
- Editor: react-grid-layout drag/resize, saves with optimistic version. A 409 is resolved in the
  client — re-read, replay the drag onto the server's layout, retry once — and only a second one
  raises the conflict banner offering a reload; settings modal (rename/share).
- **The persisted layout is canonical; the mobile view is a derived projection.** Below 640px the
  grid renders a computed one-column stack, and layout events are ignored there (and on read-only
  dashboards), so the projection can never overwrite the desktop arrangement. Editable mobile
  layouts would need their own per-breakpoint persisted layout — deliberately not built.
- **Layout saves are serialized and coalesced**: one PUT in flight at a time plus one latest-pending
  layout, each send re-reading the version the previous save returned. Rapid drag/resize therefore
  can't conflict with itself or install an older layout; a 409 means a *real* other-editor conflict.
- **Dashboard mutations share one success/failure contract**: store actions never throw —
  value-producers resolve `T | null`, void ones resolve `boolean`, and the store owns the error
  toast. Dialogs close, inputs clear, and navigation happen only on a truthy result, so a failed
  create/rename/widget-add/share-add keeps the user's input instead of discarding it.
- Widget types: **list** (bind existing or auto-create), **clock**, **calendar**, **agenda**
  (today/overdue/upcoming). Add-widget wizard picks type → resource where applicable.

**Sharing** (groups feature was removed — per-resource shares replaced it)
- Dashboards are shared by **single-use invite link** carrying viewer/editor; owner = creator. There
  is no user search — the owner mints a link and sends it themselves, so no one can discover who else
  has an account. Codes are stored hashed, expire, are shown once, and can be revoked while unused;
  the public `/invite/:code` page previews the dashboard and inviter, and accepting is a separate POST
  so scanners can't burn a link.
- Lists and calendar events inherit access from the dashboard that binds them; their `/shares`
  endpoints are deliberate 409 stubs. Share/unshare notifies affected users and cleans up
  their preferences.

**Lists**
- Master/detail lists UI with nested routes + mobile slide nav; items support check, due date,
  priority, category, assignee, manual sort order. Delete moves a list to the trash in one action
  (no archive-first gate) — it unbinds the widgets that showed it and is restorable for 30 days via
  `GET /lists/trash` + `POST /lists/{id}/restore`. Soft delete throughout.
- **Drag-and-drop reorder** (dnd-kit) of items within a list and of lists in the sidebar, via
  drag handles with keyboard support. Order persists through two transactional endpoints
  (`PUT /lists/{id}/items/order`, `PUT /lists/order`) that renumber `sort_order` to `0..n-1`
  under a row lock and require the submitted id set to match exactly (409 otherwise); DB CHECK
  constraints keep `sort_order` nonnegative. Checked items stay in place — manual order is the
  only order. New lists append last.
- The sidebar has an **Active/Trash** selector: Active is the default and is reorderable; Trash
  lists deleted lists with their purge deadline and a Restore action, and is fetched only when
  opened. The server renumbers the dashboard's live lists, so a reorder's submitted set must equal
  that set. The dashboard `ListWidget` is deliberately not reorderable — it sits inside
  react-grid-layout, whose own drag would conflict.
- The hot list SSE events — reorder, plus item check/update — carry the new state (id order, or
  the changed fields' values), so other clients patch their caches in place with no follow-up
  GET. A refetch happens only if the payload is absent (older events) or the patched result
  diverges from cache. Rarer events (create/delete) deliberately keep
  invalidate-and-refetch: self-healing is worth more than bytes on cold paths. See
  [FDR-008](docs/fdr/FDR-008-realtime-sse.md) / [ADR-006](docs/adr/ADR-006-rest-fetch-sse-patch.md).

**Calendar**
- Day/week/month views; full event editor (mobile-optimized) with weekly recurrence, duration
  toolbar, all-day, timezones; per-occurrence overrides and cancellation. Occurrence expansion
  over a required window (max 366 days).
- **Day-dependent views refresh at local midnight.** A shared `useLocalDay()` hook re-renders at the
  next local midnight (DST-safe) and on tab wake (visibility/focus); the calendar widget and page
  re-derive "today" from it, and the agenda widget background-refetches on a day rollover — so an
  always-on wall display never shows yesterday's agenda/highlights after midnight.

**Notifications & activity**
- In-app inbox (unread-first, mark one/all read) with live SSE push; activity feed of the
  caller's own events, keyset-paginated, filterable by category or event type. Everything logged is
  readable back — nothing is withheld, and repetitive churn collapses into one row instead.
  Live SSE appends are gated on the same predicate the endpoint serves, so nothing shows that a
  refresh would take away; adjacent widget moves on one dashboard collapse into a single counted row.

**Real-time (SSE)**
- One multiplexed `EventSource('/api/sse')` per user; in-memory manager with bounded queues,
  `connected` priming event carrying the activity log's high-water mark. A reconnect hands that
  mark back as `?last_event_id=`, and the server resyncs only if the log moved past it — so a
  deploy, during which no write can happen, costs no refetch at all. When a resync *is* needed the
  frame names which entity types changed on dashboards the client can see, so it refetches only
  those caches; an unknown or absent scope widens back to all of them. Frontend routes events to
  Zustand stores / scoped-query resource caches with client-mutation-id echo suppression.
- A client whose queue overflows is evicted with a closed sentinel, so its stream ends with a
  `resync` and reconnects — rather than staying connected and silently deaf.
- A stream rejected with an HTTP error status (`readyState === CLOSED`, which `EventSource`
  never retries) reconnects on jittered exponential backoff (1s → 30s cap, indefinitely) and
  never logs anyone out; every fourth attempt probes `/auth/me`, so a genuinely signed-out tab
  is discovered without a dead backend being mistaken for one. That path reconnects with its
  mark on the query string, since a fresh `EventSource` sends no `Last-Event-ID` header; a tab
  holding no mark still asks for the resync itself. The browser's own auto-retry is left alone.
- **The UI admits when the stream is down** — an amber dot while reconnecting, on the sidebar
  account avatar and on the mobile navigation button, since below `sm:` the sidebar is an overlay
  and a phone is where a stream drops most. Only the degraded state is drawn: a dot that reads
  green all day stops being read, and the failure worth surfacing is the app looking live while
  receiving nothing. The dot is decorative; each surface carries its own wording (a `title` on the
  account button, the `aria-label` on the mobile one). It reflects *your own* stream, not who else
  is online — there is no presence feature. Raised on any `error`, including the below-HTTP drops
  the browser retries itself, and cleared by the next `connected` frame.
- Streams revalidate their session every 30s and end when it is revoked; revocation also drops
  them in-process immediately (the drop is a latency optimisation, not the guarantee — the periodic
  check is worker-agnostic and holds without it). Closes #8's authorization half: a revoked session
  stops streaming within 30s and stops being accepted on requests immediately.

**UI primitives & accessibility** (#27)
- All modals share one Radix-based `ui/Dialog` (focus trap, labelling, Escape, focus restore);
  the confirm dialog is parameterized (`confirmLabel`/`tone`) so its button names the action.
  The notification panel is a Radix Popover; dashboard-card actions live in a visible Radix
  overflow menu (≥44px target); desktop hover-revealed row actions also reveal on keyboard
  focus; toasts announce via a persistent `role="status"` live region.
- **Validation is attached to the field that failed**, not toasted: `ui/FormField` wires
  `htmlFor` + `aria-invalid` + `aria-describedby` and renders the message in a `role="alert"` the
  input points at, so it is announced on submit *and* again when focus reaches the offending
  control, and it persists until fixed rather than expiring on a toast timer. Inline editors
  (list name in the sidebar and on the detail page) validate in the editor for the same reason —
  the page-level handlers no longer own an empty-name check they couldn't attach to anything.
  Multi-field forms mark every failing field at once, so the form is fixed in one pass.

**Performance shape**
- **The calendar window is a SQL predicate, not a Python filter**: a one-off event is loaded only
  if its own times overlap the requested window, and a recurring one only if `starts_at` precedes
  the window and — where the rule carries `until` — `until + duration` follows it, read straight
  from the JSONB. A finished or not-yet-started series never reaches Python. Series with a `count`
  limit and no `until` still load unbounded, since finding their end means expanding the rule. The
  window itself is capped at 366 days.
- **Resource caches are bounded** (#24): `createScopedQuery` keeps the 32 most recently fetched
  scopes and evicts the coldest, except entries with a mounted subscriber or a request in flight,
  which are never evicted. Before this, a tab left open on the calendar accumulated one entry per
  window scrolled to until logout.
- **Occurrences are cached by interval, not by request window.** One store per dashboard tracks
  which time ranges it has loaded and fetches only the gaps, so the calendar page, the calendar
  widget and the agenda widget share one copy of any day they all show — where previously each
  kept its own entry and refetched the overlap. Windows asked for in the same tick are coalesced
  into a single request, which is what a dashboard does when its widgets mount together. Coverage
  is capped at 366 days, dropping the ranges furthest from what is on screen.
- **Widget config changes patch instead of reloading.** A `dashboard.updated` event whose
  `changed_fields` is exactly `['widgets']` carries the new config, so other viewers patch that
  widget in place — without touching `dashboard.version`, which only layout writes move and which
  `PUT /layout` compares to detect a concurrent edit. Reloads that do still happen are debounced,
  so dragging several widgets costs each other tab one GET rather than one per event.
- **Sign-out resets are self-registering.** Resource caches register their own reset as they load,
  and `stores/auth.ts` calls one `resetAllResourceData()`, so a cache added later cannot be left
  out of the account boundary — a cache that never loaded holds nothing to clear.

**Infra / tooling**
- Docker Compose dev + prod, Caddy in prod (behind a Cloudflare Tunnel), named volumes, health checks.
- **Metrics at `/metrics`, in Prometheus exposition format, deliberately outside `/api`.** That
  placement *is* the access control: Caddy proxies only `/api/*`, so a public `/metrics` request
  falls through to the SPA and gets `index.html` — verified, zero series in the body — and the prod
  backend publishes no port, leaving the Docker network as the only route in.
  Built on `prometheus_client`, so the exposition, the label handling and the multiprocess path
  are the library's rather than ours. Series: SSE connects / resyncs / evictions / lifetime
  expiries, open streams (each browser tab is one, so this counts streams rather than people) and
  deepest queue, retention sweeps plus the unix time of the last
  successful one, rate-limit rejections, DB pool checked-out / size / overflow / limit, and
  `http_responses_total{method,route,status_class}` — labelled by route *template*, never the raw
  path, so a scanner cannot mint a series per URL. Beside it sit two unlabelled counters an alert
  can actually be built on: `http_server_errors_total`, and `login_successes_total` as the
  denominator that turns login failures into a share. Status counting is pure-ASGI middleware, never
  `BaseHTTPMiddleware`, which reads a streaming response to completion and would buffer SSE; it
  counts a crash on the way past, because the 500 for one is built above it and it would otherwise
  see only the deliberate ones.
  A Prometheus container joined to the `internal` network scrapes it every 15s at
  `frontdashboard-backend:8000/metrics`. Two Grafana dashboards live in [`observability/`](observability/) —
  an overview carrying the availability and latency SLIs, and an internals board for pool, hashing
  and stream detail — with seventeen alert rules beside them in Prometheus format, which is the one
  Grafana's rule importer accepts. All three are loaded by hand through the Grafana UI rather than
  reaching the deployment host, and `test_observability_coverage.py` fails the build if any names a
  metric the code no longer registers. The connects-to-resyncs ratio is what says whether reconnect
  marks are sparing anyone a refetch; the pool gauges are what a scaling decision reads. Both
  saturation gauges report the peak since the previous scrape rather than the instant value, so a
  burst that opens and closes between two scrapes still counts. Transactional email is counted by
  outcome because it is sent from a background task: a failed send answers 2xx and reaches no other
  signal.
- **Rejected auth attempts are counted by cause**, as `auth_failures_total{operation,reason}` —
  both labels closed enumerations, so cardinality is bounded. It exists because `status_class`
  collapses 401 and 403 into one `4xx` series, which makes "wrong password" and "unverified email,
  check your inbox" indistinguishable: one is a security signal, the other a support one. Splitting
  `unknown_user` from `bad_password` separates credential stuffing against a harvested list from a
  targeted attack on accounts that exist — the distinction [ADR-011](docs/adr/ADR-011-enumeration-safe-login.md)
  deliberately hides from the *response*, safe here only because the counts are aggregate and
  `/metrics` is unreachable from outside. Failing goes through `auth_failure(...)`, which builds
  the exception and counts it in one call; `test_auth_failure_coverage.py` fails the build on a
  bare 401/403 raised anywhere in the auth layer. Expect `session`/`no_cookie` to dominate — every
  logged-out tab mints one, so it is a baseline, not an alert.
- **Argon2 saturation is visible as both a level and a distribution.** `argon2_in_flight`,
  `argon2_waiting` and `argon2_limit` read straight off the capacity limiter at scrape time, so
  occupancy is a ratio rather than a number needing `argon2_max_concurrency` remembered. The gauges
  alone would lie by omission — saturation is bursty and a 15s scrape lands between bursts — so
  `argon2_seconds{operation}` histograms every hash and verify including its wait for a slot. The
  hash cost is near-constant, which makes everything above the p50 floor queueing.
- **Scale is by replica; the container runs one worker.** Forked workers share a listening socket,
  so one `/metrics` scrape reaches an arbitrary one and every counter reads as resetting — a replica
  is its own scrape target and has no such problem. `WEB_CONCURRENCY` is therefore inert and only
  logs a warning. A second process of either kind is not yet safe regardless: SSE clients and
  rate-limit counters both live in process memory until the Redis backplane lands (#21/#45), which
  the fan-out and resync invariants are maintained to keep a swap. Migrations stay in the container
  command, where `alembic/env.py`'s session-scoped advisory lock already serialises replicas
  starting together.
- **The frontend waits for the backend to start, not to be healthy.** Caddy resolves its upstream
  per request, so container start is enough; waiting on health stalled every restart and served
  nothing meanwhile, instead of the shell plus a 502 on `/api`.
- **A failed load is visible rather than blank.** `index.html` is served `no-cache` so it can
  never ask for bundles a deploy deleted; `/assets/*` sits outside the SPA fallback, so a missing
  bundle 404s honestly instead of being handed HTML the browser fails to parse as a module, and
  fingerprinted names cache for a year while the 404 itself is `no-store`. `index.html` also ships
  static markup inside `#root` that a CSS delay reveals if the script never runs (React deletes it
  on mount, and the CSP forbids inline script). An unknown URL renders a 404 page that names the
  path rather than silently redirecting — a truncated reset or invite link is the usual way there.
  See [ADR-019](docs/adr/ADR-019-static-asset-serving-contract.md).
- **Both production images run unprivileged** (uid 10001). Base images float on their tags, so a
  rebuild takes each one's security patches on its own; they were pinned by digest until four sat
  months behind, because nothing sends digest-only bumps and a rollback pulls a published image
  rather than rebuilding. Every CI build passes `pull: true` so the layer cache cannot hold a build
  to a stale base, and `uv` keeps a version tag — a tool, not a patched base, so a resolver change
  should arrive as a reviewable bump. Caddy carries no Linux capability at
  all: `:80` binds because `net.ipv4.ip_unprivileged_port_start` is 0, which the compose files set
  explicitly rather than inherit from the daemon, so the port the tunnel points at never had to
  move. CI asserts both images are non-root.
- **Liveness and readiness are separate.** `GET /api/health` answers "the process is up" and touches
  nothing, so a dependency outage can never look like a crashed process. `GET /api/health/ready` runs
  a bounded `SELECT 1` and returns 503 when the database is unreachable, hung, or the pool is
  exhausted — the container healthcheck uses this one, so a database outage shows as unhealthy.
- **A scheduled reaper bounds every table that grows on its own.** Expired tokens and invites go,
  as do sessions past either their idle or absolute window — the same two clocks the request path
  refuses to authenticate against, so nothing collected here could still have been used; activity events and notifications —
  the only tables that grow with usage rather than user count — are pruned past a 90-day horizon.
  It runs under a Postgres advisory lock, so extra workers can each schedule it and exactly one
  sweeps. Pruning history is safe for SSE because a reconnect is answered with a resync rather than
  a replay; the mark it carries is only compared against the log's head, never read from history. It also purges **unverified signups past 30 days** — registration is
  open to the internet, so abandoned ones accumulate; login 403s until an address is verified, so
  such an account holds no content, and purging it frees an email the unique index would otherwise
  reserve forever. Accounts that **do** own content are excluded **per user** rather than vetoing
  the sweep — which matters because users predating email verification (2026-04-30, whose migration
  did not backfill) read as unverified forever despite having been ordinary users. They recover by
  logging in: the 403 redirects to the resend-verification page with their address prefilled.
- **The connection pool is bounded** (10 connections: `db_pool_size` + `db_max_overflow`), with a
  pool-acquire timeout, connection recycling, and a server-side `statement_timeout`. A request burst
  fails fast instead of queueing without limit or opening connections until Postgres runs out of
  memory. All of it is config.
- **Production config fails fast**: `ENVIRONMENT` is a **required** validated enum (a prod deploy that
  forgets it won't boot rather than silently running insecure), and production startup aborts on a
  missing `resend_api_key` or an undeliverable `email_from`. Startup logs the active environment and cookie posture (`INFO` prod / `WARNING`
  otherwise).
- **Every mutating route is rate-limited**, not just the auth ones: `WRITE_LIMIT` (300/min) is
  applied per route because slowapi's app-wide limit cannot see through included-router nesting,
  and `test_rate_limit_coverage.py` fails the build if a route is added without one. Caddy caps
  request bodies at 1MB. Neither bounds *total* storage — that is #61.
- **Rate limits are per real client IP**: the limiter keys on Cloudflare's `CF-Connecting-IP` (the
  origin is a non-public Cloudflare Tunnel, so it's authoritative), falling back to the peer address
  in dev — so auth limits isolate per client instead of collapsing into the shared proxy IP. Buckets
  are in-memory/per-process, correct for the current single worker: N workers would mean N× every
  limit. Going shared is a `storage_uri` on the `Limiter` pointed at Redis, so it stays a one-line
  change rather than a pre-built knob — and it has to land *with* the first replica, not after it
  (#21/#45).
- **The backend schema is the API contract** ([ADR-018](docs/adr/ADR-018-generated-validated-contracts.md)):
  `make contracts` exports FastAPI's OpenAPI document and generates the frontend's zod schemas into
  `frontend/src/api/generated/contract.ts` (committed; CI fails on drift). Every response body is
  validated at the network boundary, widgets are a discriminated union on `widget_type`, and SSE
  frames validate against generated frame schemas — so a new backend event type or widget type is a
  compile error in the client code that must handle it.
- CI: independent parallel lanes, so one run reports every failure rather than the first — lint
  (Ruff/Biome), dead-code and dependency gates (knip, deptry), workflow linting (actionlint), tests
  (pytest, Vitest), `ty` + `tsc` type checks, contract drift, a dependency audit (osv-scanner over
  both lockfiles), and both production image builds as a matrix. A **smoke job** then boots the two
  images together against a throwaway database — [docker-compose.smoke.yml](docker-compose.smoke.yml)
  layered over the real prod Compose file, so a drift between it and the Caddy upstream fails here
  rather than at deploy — and asserts the serving contract of
  [ADR-019](docs/adr/ADR-019-static-asset-serving-contract.md): readiness through the proxy,
  `no-cache` on the document, an immutable JavaScript bundle, a 404 for a missing asset, SPA
  fallback for an unknown path. Publishing to GHCR is gated on all of it, and those are the images
  production pulls — there is no path that builds and pushes without passing them first. Backend tests build their
  schema with `alembic upgrade head`, so **migrations run on every backend test run** and
  `test_migrations.py` fails on ORM↔migration drift; `make test-unit` runs the Docker-free subset.
  Pre-commit hooks incl. Conventional Commit enforcement, and CI checks the PR title by the same
  grammar. Dependabot is grouped and **monthly**, majors included: weekly churn was noise, and
  batching keeps upgrades incremental rather than deferring them into one forced jump.

## In flight

- **Design-review remediation** (open work tracked in [docs/TODO.md](docs/TODO.md)): the
  security-first phases are done — Phase 1 (security quick wins), Phase 2 (auth/session hardening,
  incl. the 2026-07-17 follow-up security review), and Phase 3 (dashboard correctness) all shipped by
  2026-07-20. The durable decisions from
  these phases are captured in the [ADRs](docs/adr/INDEX.md) / [FDRs](docs/fdr/INDEX.md). **Phases
  4–6 (data layer/contracts/exposure, infra/CI/ops, UX & cleanup) and the unscheduled backlog
  remain** — see [docs/TODO.md](docs/TODO.md).

## Deliberately deferred / known dead code

- Remediation backlog (Phases 4–6 + unscheduled triage) — tracked in [docs/TODO.md](docs/TODO.md),
  not here.
- `CalendarReminder` model + table exist with **no** router/service usage — reserved schema for a
  future "notify me N minutes before" feature, kept deliberately (see
  [FDR-006](docs/fdr/FDR-006-calendar-and-events.md)), not dead code to remove.
- Share principal types other than `user`, and share roles beyond viewer/editor, are
  intentionally not built.
