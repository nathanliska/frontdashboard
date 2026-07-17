# Design — Session revocation: real sessions, atomic rotation, revocable streams

**Date:** 2026-07-16
**Status:** 🚧 Design — not started
**Findings:** #6 (single-use tokens under concurrency), #7 (revoke sessions when credentials
change), #8 (**authorization half only** — the eviction half shipped 2026-07-16, `44a9e15`).
Also folds in one unlogged defect found while designing: `POST /auth/refresh` has neither
`require_csrf` nor a rate limit.

**Not in this doc.** Phase 2's label covers six findings that share a theme but not a mechanism.
This is spec 1 of 4. The others are independent and get their own specs: #1 (frontend auth-boundary
reset), #13 (Argon2 off the event loop), #31 (email normalization + config validation).

## Theme

The app has no concept of a session. It has refresh tokens, which rotate — so identity dissolves on
every rotation and there is nothing to revoke, name, or bound. Every defect below is a symptom of
that single absence:

- **#7** — a password change cannot revoke "your other devices", because no row represents a device.
- **#8 authz** — a stream cannot be ended when authority is withdrawn, because no authority outlives
  the JWT to withdraw.
- **#6** — rotation cannot detect token reuse, because successive tokens are unrelated rows.

So this design introduces the missing noun — a `sessions` row, one per login, stable across
rotation — and the three findings collapse into consequences of having it.

---

## What is actually true today (verified in code)

Corrections to the findings, established before designing:

- **The session-metadata columns already exist.** `refresh_tokens.device_name`, `.ip_hash`,
  `.user_agent_hash`, `.last_used_at` (`models/refresh_token.py:20-24`, migration `b7c3e1a9d5f2`)
  are **never written by anything**. #7's "expose device sessions using the existing metadata
  fields" needs no migration to add them — they are dead schema, not missing schema.
- **A per-request DB lookup already happens.** `dependencies.py:27` selects the user by id and
  filters `deleted_at`. #8's gap is a *revocation check*, not a missing lookup.
- **The locking pattern already exists in-file.** `verify_email` uses `.with_for_update()`
  (`auth.py:259`). Only `/refresh` (`:392`) and `password-reset/confirm` (`:331`) lack it.
- **`/auth/refresh` has no `require_csrf` and no rate limit** — the only unauthenticated POST in
  the router without either. Not a logged finding. Folded in here because this spec rewrites the
  endpoint anyway.
- **The reset race is wider than it looks.** `hash_password` (~50-100ms of Argon2) sits *between*
  the token read and the commit (`auth.py:348`), inside the transaction.

Logged as a **new finding**, not fixed here: `login` short-circuits on unknown email
(`auth.py:371`), so a missing account answers in ~0ms while a real one pays a full Argon2 verify —
a user-enumeration timing oracle. Its fix is a dummy verify on the miss path, which collides with
#13's move of hashing to a thread pool. It belongs to that spec.

---

## Data model

**New table `sessions`** — one row per login, the `sid`. The **model class is `UserSession`**, not
`Session`: this codebase lives in `AsyncSession`/`sessionmaker` territory, and a model named
`Session` sitting next to SQLAlchemy's own `Session` in the same import namespace is a footgun for
every future reader. The table stays `sessions`.

| Column | Notes |
| --- | --- |
| `id` | UUID PK. This is the `sid` claim. |
| `user_id` | FK → `users.id`, `ondelete="CASCADE"` |
| `created_at` | server_default now() |
| `last_used_at` | updated on rotation only — never per request |
| `revoked_at` | nullable; non-null = dead |
| `device_name`, `ip_hash`, `user_agent_hash` | **moved** from `refresh_tokens` |

Index: `(user_id, revoked_at)` for "all live sessions for this user".

**Sessions have no `expires_at`, deliberately.** A session's life is already bounded by its refresh
token: once that expires (7d) nothing can rotate, so the session is unreachable whether or not a
column says so. A second expiry to keep in sync with the first would be a source of drift, not
safety. The consequence to accept: rows accumulate — revoked and naturally-dead sessions are never
collected. At household scale that is a few rows per login and not worth a reaper; it is noted in
"deliberately not doing" so the next reader knows it was a decision rather than an oversight.

**`refresh_tokens` changes:**

- **add** `session_id` FK → `sessions.id`, `ondelete="CASCADE"`
- **add** `revoked_at` timestamp, **replacing** the `revoked` boolean — the grace window needs to
  know *when* a token was consumed, not merely *whether*
- **drop** `device_name`, `ip_hash`, `user_agent_hash`, `last_used_at` — they move to `sessions`
  (dropping dead columns; no data to preserve)
- keep one row per token: a rotation chain must be preserved (see "Why not rotate in place")

`users` is **unchanged** — no `token_version` column. Revocation is per-session by design.

### Why not rotate in place (rejected)

The tempting smaller design: make the session *be* the refresh-token row, rotate `token_hash` in
place, keep `previous_token_hash` for the grace window. The row id becomes the `sid`, and the dead
metadata columns come alive with no new table.

It breaks on the exact case this design exists to serve. Two tabs race. Tab A rotates (`previous` =
old, `current` = new). Tab B replays old, lands inside the grace window, rotates again (`previous` =
old, `current` = newer). Tab A now retries with *its* token, which matches neither `current` nor
`previous` → the server concludes theft and revokes the session. **The grace window would cause the
logout it exists to prevent.** One row remembers one predecessor; a stampede needs a chain. Hence
one row per token.

---

## Rotation and the grace window (#6)

The consume becomes atomic — the database picks the winner, not the application:

```sql
UPDATE refresh_tokens SET revoked_at = now()
 WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now()
 RETURNING *
```

If it returns a row: rotate normally — mint a successor in the same session, bump
`sessions.last_used_at`.

If it returns nothing, re-read by `token_hash` **unfiltered** and decide. The `expires_at`
predicate matters: without it an expired token would rotate happily, and with it a plain expiry
must not be mistaken for theft — so expiry is checked **before** the reuse branch:

| State | Meaning | Response |
| --- | --- | --- |
| No such token | garbage | 401 |
| `expires_at` ≤ now (rotated or not) | ordinary expiry — the user was away | 401, **no** revocation |
| session already revoked | logged out / password changed | 401 |
| `revoked_at` < 10s ago, session live | the tab stampede | **allow**: mint a successor in the same session |
| `revoked_at` ≥ 10s ago | held and replayed — theft shape | **revoke the session**, 401 |

Order is load-bearing: an expired-and-previously-rotated token matches both the expiry row and the
reuse row, and it must be read as expiry. Punishing a user who closed their laptop for a week by
revoking a session that already had no way to continue would be noise, not security.

Revoking a session does **not** require revoking its tokens individually: every path that consumes a
token joins `sessions` and rejects a revoked one, so `sessions.revoked_at` alone is sufficient and
the tokens die with it.

`password-reset/confirm` gets the same atomic treatment (`UPDATE ... WHERE used_at IS NULL
RETURNING`), which also removes the Argon2 hash from inside the read→commit window.

### The grace window is not optional

Both tabs share one access-token cookie, so it expires for both at the same instant, and both call
`/refresh` at once. **The race is the normal case, not an edge case.**

Today's bug masks it: both requests win, two tokens are minted, the last `Set-Cookie` wins, nobody
notices. Making the consume atomic *without* a grace window converts that silent-benign bug into a
**visible regression** — the loser gets a 401, `tryRefresh` returns false, and `apiFetch` sends the
user to `/login` (`api/client.ts:40`). A naive fix to #6 logs users out.

### Semantics: successors, not identity

This is Auth0's "refresh token rotation reuse interval", not "return the identical token". We store
only hashes and **cannot** reissue the same raw token. Each racing tab therefore gets its **own**
successor; both are valid; both belong to one session. The cookie jar keeps the last one written;
the other is orphaned — it exists only in a response the same browser already discarded, and
revoking the session kills it regardless. Strictly better than today, where the identical
double-mint happens with no session to revoke.

**Window: 10 seconds.** Long enough for a tab stampede plus a slow refresh; far shorter than any
plausible hold-and-replay.

---

## Revocation (#7)

One choke point, `revoke_session(...)`, is the *only* way a session dies. Every trigger routes
through it:

| Trigger | Scope |
| --- | --- |
| `POST /auth/logout` | current session only |
| `PATCH /auth/password` | **all sessions except the caller's `sid`** — the #7 fix |
| `POST /auth/password-reset/confirm` | all sessions (unauthenticated flow — no session to spare) |
| reuse detected outside the grace window | that session |

`PATCH /auth/password` currently revokes nothing (`auth.py:480-503`); it only re-issues the access
cookie. That asymmetry against `password-reset/confirm` (which revokes all, `auth.py:349-356`) is
the finding.

---

## Enforcement on requests

The access JWT gains a **`sid`** claim (`tokens.py:15-20` currently carries `sub`, `email`, `exp`,
`iat`). `_resolve_current_user` joins `sessions` into the query it **already runs**, so per-request
cost stays one round trip:

```
select(User).join(Session).where(
    Session.id == sid,
    Session.revoked_at.is_(None),
    User.id == sub,
    User.deleted_at.is_(None),
)
```

A revoked session 401s **immediately** rather than surviving up to 15 minutes.

Tokens minted before this ships carry no `sid` → 401 → refresh → their refresh token was revoked by
the migration → `/login`. Correct, and consistent with the migration's one-time re-login.

---

## Enforcement on SSE streams (#8's authorization half)

### #8's proposal is superseded by this design's premise, not overruled

#8 proposes: *"End connections at token expiry and require reauthentication."* This design does not
do that — but the reason is a **changed premise**, not a difference of preference, and the
distinction matters to anyone auditing whether the finding was really addressed.

The proposal was written for the code as it stands, where **the JWT is the only authority**. In that
world, bounding the token's lifetime is the only lever available, and reaching for it is correct.
This spec moves the authority to the session. Once it does, "bound the JWT" stops *being* a way to
bound authorization and becomes a **proxy** for it — and a poor one:

- **Weaker.** It bounds *JWT lifetime*, not *session authority*. Once `sessions` is the authority, a
  stream outliving a 15-minute JWT on a valid session is not a vulnerability — it is a long-lived
  authorized connection. Meanwhile a session revoked one minute after a refresh would keep streaming
  for fourteen more.
- **Expensive.** Every tab shares one access-token cookie and so expires *simultaneously*. Every
  stream dies at once → browser auto-retry → 401 → 1s backoff → refresh → reconnect → and because
  the auto-retry carries `Last-Event-ID`, a full `resync` and a complete cache refetch. ~3-4s of
  blindness plus a GET storm across every tab, every 15 minutes, forever — the exact cost
  `docs/shipped/sse-hardening-design.md` exists to avoid.

Note the direction of travel: revalidation is **more** work and a **stronger** guarantee than the
proposal it replaces. The usual hazard when a spec deviates from a finding — quietly substituting
something cheaper and declaring victory — runs the other way here.

**#8's disposition must record this explicitly**, and must state the claim in terms a reader can
check rather than in terms of compliance. Not *"did you end streams at token expiry?"* but:

> **A revoked session stops streaming within 30 seconds, and stops being accepted on requests
> immediately.**

That is testable, and it is the thing the finding actually wanted. Whether the JWT's clock was
involved is an implementation detail of a premise this spec removed.

### What this design does instead

**The guarantee — periodic revalidation.** `_Client` carries `session_id`. `stream_events` compares
a deadline **on every loop iteration** and revalidates every **30s**, ending the stream when the
session is gone.

> **The existing 5s `wait_for` timeout is an idle timeout, not a heartbeat.** It fires only when the
> queue is empty, so a client receiving a steady trickle of events never times out. A check hung off
> the `TimeoutError` branch would never run for the busiest clients — the ones it matters most for.
> The deadline must be compared on **both** branches. The 5s timeout still bounds how late an *idle*
> stream can notice.

Cost at household scale (≈9 clients, N=30s): ~18 queries/minute against a primary key. It checks the
**session in the database**, which is strictly stronger than re-checking a JWT, and it assumes
nothing about worker count or code discipline.

**The optimisation — in-process drop.** `revoke_session()` also calls into the SSE manager to drop
that session's clients immediately. This is **explicitly not load-bearing**: it makes the common case
instant, while the periodic check is what makes the invariant true. If the drop is buggy, or a second
worker appears, the guarantee still holds — 30 seconds later. Building it the other way round would
promote the drop's dependencies (single worker, choke-point discipline) into correctness
dependencies.

**A new `REVOKED_SENTINEL`,** distinct from `CLOSED_SENTINEL`. `CLOSED_SENTINEL` means "you fell
behind — resync", which is wrong here: a revoked client that resyncs fires a burst of GETs that all
401 and end at `/login` anyway. `REVOKED_SENTINEL` ends the stream with **no** resync frame; the
client reconnects, 401s, fails to refresh, and lands on `/login`.

### Injected revalidation (testability)

`revalidate` is **injected into `stream_events` as a callable**, not reached for:

```python
async def stream_events(
    client: _Client,
    *,
    send_resync: bool,
    revalidate: Callable[[uuid.UUID], Awaitable[bool]],
) -> AsyncGenerator[dict, None]:
```

Production passes one that opens its own short-lived session from `async_session_factory`
(`database.py:12`) — the request's session must not be pinned for the stream's lifetime, which is
why `get_current_user_for_stream` already uses `Depends(get_db, scope="function")`.

**This is not stylistic.** Tests override `get_db` to yield a savepoint-bound session. A revalidation
that reached for `async_session_factory` directly would bypass the override, query the real database
outside the test's savepoint, fail to see the session row the test just created, conclude "revoked",
and kill the stream — every SSE test failing for a reason that looks nothing like the cause. Same
move, and same reason, as `stream_events` being module-level at all (`44a9e15`).

### Single-worker dependency

The in-process drop works because revocation and the manager share a process. That is the assumption
the manager already makes. A second worker breaks the *optimisation* but not the *guarantee* — the
30s revalidation is worker-agnostic. Cross-process delivery is #21, deliberately deferred until a
second worker is real.

---

## `/auth/refresh` hardening (unlogged defect, folded in)

- add `_csrf: None = Depends(require_csrf)` — per `backend/CLAUDE.md`, **every non-GET route must**,
  and every sibling route already does
- add a `@limiter.limit` decorator matching the other auth endpoints

---

## Migration

One revision, chaining from the current head **`a3f7c2e9d1b4`**:

1. create `sessions`
2. **drop the index `ix_refresh_tokens_user_active`** — it is on `(user_id, revoked, expires_at)`
   (`models/refresh_token.py:13`), and step 3 drops `revoked` out from under it
3. add `refresh_tokens.session_id`, `refresh_tokens.revoked_at`; drop `revoked`, `device_name`,
   `ip_hash`, `user_agent_hash`, `last_used_at`
4. **recreate the index** as `(user_id, revoked_at, expires_at)`, and update `__table_args__` in
   the model to match — an index the ORM declares but the database lacks is invisible until it is
   slow
5. **revoke every existing refresh token** — no backfill

Existing sessions cannot point at a `sessions` row that never existed, so everyone signs in once
more. Chosen over a backfill deliberately: it is a household app with a handful of users, a
password-hardening release is the least surprising moment to be asked to sign in again, and — since
tests build schema via `Base.metadata.create_all` and **never exercise migrations** — a backfill
would ship with no automated coverage at all.

Style: hand-authored 12-char slug, explicit `down_revision = "a3f7c2e9d1b4"`.
`backend/CLAUDE.md`: a new model module must be imported in **both** `alembic/env.py` **and**
`tests/conftest.py`.

---

## Testing

### The harness cannot currently test the race at all

`conftest.py` gives every request in a test **one shared `AsyncSession` on one connection**, with
`join_transaction_mode="create_savepoint"` and an outer rollback. Therefore:

- `db.commit()` in a route only **releases a savepoint** — it never really commits, so the
  cross-transaction visibility the race depends on cannot occur
- two "concurrent" requests serialize onto one session (and interleaving them corrupts session
  state rather than reproducing a race)
- `with_for_update()` can never block, because there is only ever one transaction

**So a `concurrent_sessions` fixture is in scope for this spec.** It builds two independent sessions
from `_test_engine` (already `NullPool`, so distinct connections) with **real** commits, and cleans
up explicitly — real commits escape the outer rollback.

The justification is #6's own sentence: *"Sequential tests cannot expose this race."* Shipping the
atomic consume with only sequential tests reproduces the exact mistake the finding is about. And
`UPDATE … RETURNING` being a well-understood pattern is not reassurance — its failure mode is that
**both** requests silently win, which is indistinguishable from working.

**Deliberately minimal — roughly 30 lines.** Create a dedicated user with a unique email, hand out
two sessions, cascade-delete the user on teardown (the `sessions.user_id` FK is `ondelete=CASCADE`).

- **Clean up by user, never `TRUNCATE`.** Real-committing tests share a container with
  savepoint-based ones, whose transactions are open on other connections; a truncate would contend
  with them.
- **This is not the migration-testing project.** It does not run Alembic, does not replace
  `create_all`, does not refactor `conftest`. That blind spot is real and is explicitly *not* being
  fixed here (see "deliberately not doing"). If this fixture starts growing in that direction, stop
  and spec it separately.

### Cases

**Concurrency (needs the new fixture):**
- two simultaneous `/refresh` with the same token → both succeed, one session, no revocation
- replay at > 10s → session revoked, 401, and the session's other tokens die
- two simultaneous `password-reset/confirm` with one token → exactly one succeeds

**Revocation:**
- `PATCH /auth/password` revokes other sessions and **spares the caller's**
- `password-reset/confirm` revokes all
- `logout` revokes only the current session
- an access token whose `sid` is revoked → 401 (this is #8's authz half, at request level)

**SSE:**
- revalidation ends a stream whose session was revoked (inject a `revalidate` stub)
- the deadline fires on a **busy** stream, not only an idle one — the regression the idle-timeout
  trap would cause
- `REVOKED_SENTINEL` ends the stream **without** a resync frame
- an evicted client still resyncs (`CLOSED_SENTINEL` unchanged — no regression to `44a9e15`)

**`/auth/refresh`:** rejects a missing/incorrect CSRF header; rate limit applies.

---

## Deliberately not doing

- **A device/session list UI.** The `sessions` row makes it nearly free later; it is not this spec.
- **Cross-tab Web Locks** (`navigator.locks`) to serialize refresh in the browser. It attacks the
  stampede at the source and composes well, but it is a client-side guarantee protecting a
  server-side invariant — a stale tab, a `bfcache` restore, or a non-browser client sidesteps it,
  and Safari only gained it in 15.4. The grace window already solves the problem. Log as a future
  nicety if refresh volume ever matters.
- **A per-user `token_version`.** Rejected with "log out every device including your own" — see the
  revocation table.
- **Expiry-bounded streams** (#8's literal proposal) — superseded by the premise change, not
  overruled; see "Enforcement on SSE streams". Must be recorded in #8's disposition.
- **Multi-process revocation** (#21) — deferred until a second worker exists.
- **The login timing oracle** — logged as a new finding; belongs with #13.
- **Reaping dead sessions.** Rows accumulate; nothing collects revoked or naturally-expired
  sessions. A few rows per login is not worth a job at this scale — revisit if the table ever gets
  interesting.
- **Migration-exercising tests.** A standing blind spot (`create_all`, not Alembic), and a real one —
  but it is its own piece of work, and the no-backfill migration is what keeps this spec honest
  without it.
