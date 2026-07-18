# Design — Low-severity security batch (#49, #50, #51)

**Date:** 2026-07-18
**Status:** ◻ Planned.
**Findings:** #49 (reaper `last_used_at` invariant), #50 (`ENVIRONMENT` fail-open default), #51
(register `IntegrityError` → 500). All three from the 2026-07-17 Phase 2 security review; small,
independent, batched into one spec. #52 (SSE resync griefing) and register enumeration are separate.

## #49 — Keep `last_used_at` fresh when an access token is re-issued

**Problem.** The retention reaper deletes idle, fully-expired sessions guarded by
`last_used_at < now - access_token_expire_minutes` AND `~has_unexpired_token`, on the premise that
idleness beyond the access-token lifetime means no live access token depends on the session. But
`last_used_at` is bumped only in `issue_refresh_token` (login/refresh). `PATCH /profile` and
`PATCH /password` re-mint a 15-minute access cookie via `_set_access_cookie` **without** bumping it,
so a session whose refresh tokens have all expired but which keeps minting access cookies can be
reaped while a valid access token still references it → premature `401`.

**Fix.** In `update_profile` and `change_password` (`app/routers/auth.py`), set
`session.last_used_at = datetime.now(UTC)` before the existing `await db.commit()`. Both handlers
already receive `session: UserSession = Depends(get_current_session)` (an ORM object attached to the
request `db`) and commit, so the bump persists. `datetime`/`UTC` are already imported.

## #50 — Make `ENVIRONMENT` explicit (fail-closed) + log the security posture

**Problem.** `environment` defaults to `development`, and the production validator + `Secure` cookie
flag are gated on `environment == Environment.production`. A prod deploy that forgets
`ENVIRONMENT=production` silently runs with insecure cookies and skips secret/email validation, with
no runtime signal.

**Decision (chosen):** require it explicitly **and** log the posture at startup.

**Fix.**
- `app/config.py`: change `environment: Environment = Environment.development` to
  `environment: Environment` (no default). `Settings()` now raises `ValidationError` at construction
  if `ENVIRONMENT` is unset — fail-closed. Verified safe: the dev `.env`, `.env.example`,
  `.env.prod.example`, and `.env.prod` all set `ENVIRONMENT`.
- `app/main.py`: at lifespan startup, log the active environment and cookie posture — `INFO` for
  production, `WARNING` otherwise:
  ```python
  if settings.environment == Environment.production:
      logger.info("Starting: environment=production (Secure cookies ON, production config validated)")
  else:
      logger.warning(
          "Starting: environment=%s (Secure cookies OFF, production validation skipped)",
          settings.environment.value,
      )
  ```
  `logger = logging.getLogger("app")`; import `Environment` from `app.config`.

## #51 — `register` returns 409 instead of 500 on a unique-index collision

**Problem.** `register` pre-checks `select(User).where(User.email == body.email)` then `db.add(user);
await db.flush()`. If the pre-check misses a duplicate that the `uq_users_email_lower` functional
index catches — the `str.lower()` vs Postgres `lower()` Unicode edge, or a concurrent same-email
registration — the flush raises an uncaught `IntegrityError` → `500`.

**Fix.** Wrap the user flush in `try/except IntegrityError` → `await db.rollback()` → raise the same
`409 "Email already registered"`:
```python
db.add(user)
try:
    await db.flush()
except IntegrityError:
    await db.rollback()
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered") from None
```
Add `from sqlalchemy.exc import IntegrityError`. Same status + body as the pre-check path, so the
response is indistinguishable.

## Testing (pytest, Testcontainers)

- **#49** (`test_auth.py`): log in (auth_client), set the session's `last_used_at` to an old datetime
  via `db_session`, `PATCH /profile` with a valid change, re-fetch the session, assert `last_used_at`
  advanced to ~now. (Optionally the same for `PATCH /password`.)
- **#50** (`test_config.py`): add `test_environment_is_required` constructing
  `Settings(_env_file=None, database_url=..., secret_key="x"*40)` with **no** `environment` and
  asserting `ValidationError`. Add `"environment": "development"` to the shared `_BASE` dict so the
  other tests (which already pass `environment` explicitly) are unaffected; the new test constructs
  `Settings(...)` directly without `_BASE`.
- **#51** (`test_auth.py`): insert a `User` with a **mixed-case** email (e.g. `Edge@Example.com`)
  directly via `db_session` (bypassing schema normalization), then `POST /register` with
  `edge@example.com`. The pre-check (`email == "edge@example.com"`) misses the mixed-case row, the
  flush trips `uq_users_email_lower`, and the handler returns `409` (deterministic exercise of the
  `IntegrityError` backstop). Assert status `409`.
- Existing `test_auth.py` / `test_config.py` stay green.

## Out of scope / deferred

- **#52** (SSE resync griefing) — needs its own backpressure design.
- **Register enumeration** (fast-409 + timing discloses account existence) — a product decision
  (switch to a "we've emailed you" flow), tracked separately.
- **#45** (multi-worker shared limiter store) — still deferred.

## Execution

Subagent-driven, three small tasks (one per finding) for clean per-finding review gates.
