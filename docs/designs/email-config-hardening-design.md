# Design — Email identity normalization + production config validation (#31)

**Date:** 2026-07-17
**Status:** ◻ Planned. Phase 2 spec 4 of 4 — the last spec in the auth/session-hardening theme.
**Findings:** #31 (normalize email identity + validate production security settings). Also folds in
the **display-name bounds slice of #14** (boundary input validation), because it lives in the exact
auth schemas this spec edits and closes an obvious blank/oversized-display-name gap at registration.

**Not in this doc.** #31's `frontend_base_url` scheme-validation sub-part already shipped
(`86472fb`). The rest of #14 (dashboard name bounds, typed layout/widget config, mutation
header/body limits), #32 (CI gates), and #33 (migrations out of startup) are separate efforts and
stay untouched. Phase 2 specs 1–3 (session revocation, auth-boundary reset, Argon2 + timing oracle)
already shipped.

## Theme

Two identity/config-hygiene defects, one cohesive spec:

- **Email is case-sensitive.** PostgreSQL string equality and uniqueness are case-sensitive, so
  `Alice@x.com` and `alice@x.com` are two different accounts, and a user who registered one casing
  cannot log in with another. This allows logical duplicate accounts and case-dependent login.
- **Production config can fail open.** `environment` is a free string, so a typo (`prod`,
  `Production`) silently makes `_SECURE` false and disables secure cookies. `secret_key` strength is
  never checked, and a production instance with no email sender boots fine even though email
  verification is *required* to log in — so a misconfigured prod locks every new user out with their
  verification link buried in container logs.

## What is actually true today (verified in code)

- **Four email request schemas**, all `email: EmailStr` with no normalization
  (`app/schemas/auth.py`): `RegisterRequest`, `LoginRequest`, `ResendVerificationRequest`,
  `PasswordResetRequest`. `EmailStr` (email-validator) lowercases the *domain* but not the local
  part, so `Foo@Bar.com` stays mixed-case.
- **Four exact-match lookups** consume those (`app/routers/auth.py`): `register`
  (`select(User).where(User.email == body.email)`), `resend_verification`, `request_password_reset`,
  `login` — all `User.email == body.email`. No router logic needs to change if the value arrives
  normalized.
- **Email uniqueness is enforced two ways that disagree in name:** the model has
  `email = mapped_column(String, unique=True, ...)` (auto-named unique constraint, used by tests'
  `create_all`), while the initial migration names it explicitly:
  `sa.UniqueConstraint("email", name="uq_users_email")` (`52c10a1e9ff6_initial_schema.py:36`). Both
  are plain case-sensitive uniqueness.
- **`display_name` validation is asymmetric.** `RegisterRequest.display_name: str` has **no**
  validation (blank, whitespace-only, or arbitrarily long names register fine). `update_profile`
  (`auth.py`) *does* strip and reject empty (`422 "Display name cannot be empty"`, pinned by
  `test_update_profile_rejects_blank_display_name`) but enforces **no length bound**. The `users`
  table stores `display_name` as unbounded `String`.
- **`environment: str = "development"`** (`app/config.py`); its only consumer is
  `_SECURE = settings.environment == "production"` (`auth.py:56`).
- **`secret_key: str`** is required but unchecked; used for JWT HS256
  (`app/auth/tokens.py`). **`resend_api_key: str | None = None`** (email service logs the link when
  unset); **`email_from`** defaults to `"FrontDashboard <noreply@frontdashboard.local>"` (a `.local`
  domain that cannot deliver).
- **`Settings()` is constructed at import** from `env_file=["../.env", ".env"]`. The dev/test
  environment loads repo-root `.env` with `ENVIRONMENT=development` — so an `environment` enum and
  production-only validators do **not** affect local work or the test suite. Tests can construct
  `Settings(_env_file=None, ...)` to exercise validators in isolation.
- **Testcontainers + `asyncio_mode = "auto"`**; migrations are never run by tests (schema comes from
  `Base.metadata.create_all`), so a model-level functional index is what tests exercise; the Alembic
  migration is the prod/dev-DB path and must be kept consistent with the model.

## Design

### 1. Email normalization at the schema boundary — `app/schemas/auth.py`

```python
from typing import Annotated
from pydantic import AfterValidator, EmailStr

def _normalize_email(v: str) -> str:
    return v.strip().lower()

NormalizedEmail = Annotated[EmailStr, AfterValidator(_normalize_email)]
```

`EmailStr` validates format first; the `AfterValidator` then trims and lowercases. Replace
`email: EmailStr` with `email: NormalizedEmail` in `RegisterRequest`, `LoginRequest`,
`ResendVerificationRequest`, and `PasswordResetRequest`. Every write and all four
`User.email == body.email` lookups now receive a canonical value — mixed-case login/resend/reset
resolve to the same account, and a case-variant of an existing email takes the normal duplicate
path. No router changes.

### 2. DB uniqueness — `lower(email)` functional unique index

**Model (`app/models/user.py`):** drop the column-level `unique=True`; add a functional unique
index so the *case-insensitive* value is what's guaranteed unique (the hard backstop behind app
normalization, built by `create_all` so tests exercise it):

```python
from sqlalchemy import Index, String, func

class User(...):
    email: Mapped[str] = mapped_column(String, nullable=False)   # was unique=True
    ...
    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)
```

**Migration (hand-authored Alembic revision, chained onto the current head):**
1. **Preflight:** `SELECT lower(email) AS k, count(*) FROM users GROUP BY k HAVING count(*) > 1`. If
   any rows, `raise` with a clear message listing the colliding keys — abort the migration for
   manual resolution (household scale → almost certainly none, but never silently merge accounts).
2. `UPDATE users SET email = lower(email) WHERE email <> lower(email)` (also trim if any stored
   value has surrounding whitespace).
3. `op.drop_constraint("uq_users_email", "users", type_="unique")`.
4. `op.create_index("uq_users_email_lower", "users", [sa.text("lower(email)")], unique=True)`.
   `downgrade` reverses (drop functional index, recreate the `uq_users_email` unique constraint).

### 3. Display-name bounds (the #14 slice) — `app/schemas/auth.py` + `app/routers/auth.py`

One shared source for the limit:

```python
DISPLAY_NAME_MAX_LENGTH = 100   # matches the dashboard.name limit

def _normalize_display_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("Display name cannot be empty")
    if len(v) > DISPLAY_NAME_MAX_LENGTH:
        raise ValueError(f"Display name must be at most {DISPLAY_NAME_MAX_LENGTH} characters")
    return v

DisplayName = Annotated[str, AfterValidator(_normalize_display_name)]
```

- **`RegisterRequest.display_name: DisplayName`** — new schema-level normalization/bounds, consistent
  with how `RegisterRequest.password` is already schema-validated (both surface as pydantic 422s;
  registration already returns pydantic-shaped errors for a short password, so the frontend already
  handles that shape).
- **`ProfileUpdate` keeps handler-based validation** to preserve its existing error contract (the
  custom string-detail `422 "Display name cannot be empty"` and its passing test). Extend the
  `update_profile` handler's existing strip/empty check to also reject
  `len(display_name) > DISPLAY_NAME_MAX_LENGTH` with a custom-message `422`, referencing the same
  constant. This keeps ProfileUpdate's errors uniformly string-detail (no frontend-contract change)
  while closing the missing length bound.

### 4. `environment` as an enum — `app/config.py`

```python
from enum import StrEnum

class Environment(StrEnum):
    development = "development"
    production = "production"
    test = "test"
```

`environment: Environment = Environment.development`. An out-of-set value raises `ValidationError`
at `Settings()` construction → startup fails fast. Update the one consumer:
`_SECURE = settings.environment == Environment.production` (`auth.py`), importing `Environment`.

### 5. Fail-fast production config validation — `app/config.py`

A `model_validator(mode="after")` on `Settings` that runs its checks **only when
`environment == Environment.production`** (development/test are unaffected):

```python
@model_validator(mode="after")
def _validate_production_security(self) -> "Settings":
    if self.environment is not Environment.production:
        return self
    errors: list[str] = []
    if len(self.secret_key) < 32 or self.secret_key in _INSECURE_SECRETS:
        errors.append("secret_key must be at least 32 characters and not a placeholder")
    if not self.resend_api_key:
        errors.append("resend_api_key is required in production (email verification is mandatory)")
    if "@frontdashboard.local" in self.email_from.lower():
        errors.append("email_from must use a deliverable domain in production")
    if errors:
        raise ValueError("Invalid production configuration: " + "; ".join(errors))
    return self
```

`_INSECURE_SECRETS` is a small module-level frozenset of known placeholders (the values shipped in
`.env.example` / `.env.prod.example`), so copying an example secret into a real prod deploy trips the
check. Aggregating into one raised error lists every problem at once rather than failing one at a
time.

### 6. Env-file examples — `.env.example`, `.env.prod.example`

- Note the valid `ENVIRONMENT` values (`development` / `production` / `test`).
- `.env.prod.example` uses an obvious `CHANGE_ME_...` `SECRET_KEY` placeholder that is in
  `_INSECURE_SECRETS` (so an un-edited copy fails the production check), and documents that
  production requires `SECRET_KEY` ≥ 32 chars, `RESEND_API_KEY`, and a deliverable `EMAIL_FROM`.

## Testing (pytest, Testcontainers; config tests need no DB)

**Email normalization + uniqueness (integration, `test_auth.py`):**
- Register `Mixed@Example.COM`; assert the stored/returned email is `mixed@example.com`.
- Register mixed-case, verify, then **log in with a different casing** → 200 (case-insensitive login).
- Register `a@x.com`, then register `A@X.com` → **409** (case-variant duplicate; exercises the
  normalization + functional index end-to-end).
- `resend-verification` and `password-reset/request` with a different casing than registered still
  find the account (assert the token/email side-effect fires).

**Display-name bounds:**
- Register with `display_name="   "` → 422; with a 101-char name → 422; a normal name is stored
  trimmed.
- `PATCH /profile` with a 101-char name → `422` custom message; the existing blank-name test stays
  green (unchanged contract).

**Config (unit, `test_config.py`, `Settings(_env_file=None, ...)`):**
- Invalid `environment="prod"` → `ValidationError`.
- `environment="production"` with: a <32-char secret → error; a placeholder secret → error; missing
  `resend_api_key` → error; default `@frontdashboard.local` `email_from` → error; **all valid** →
  constructs cleanly. A single call with multiple problems lists all of them.
- `environment="development"` with a weak secret / no email config → constructs cleanly (checks
  skipped).

## Out of scope / deferred

- The rest of **#14** (dashboard name bounds, typed layout/widget config, header/body size limits) —
  separate subsystem, stays ◐ partial.
- **citext** — rejected in favor of app-layer normalization + a functional unique index (no Postgres
  extension, plain `String` column, identical behavior in `create_all`-based tests).
- Reconciling *pre-existing* case-duplicate accounts beyond the migration's abort-and-report — there
  are expected to be none at household scale; a real collision is an explicit manual decision.
- **#32 / #33** (CI supply-chain/migration gates, migrations out of startup).

## Doc/tracker updates on ship

Closes #31 (→ ✅ Shipped) and advances #14 to a further partial (display-name slice done). Update
both dispositions + the Phase 2 rollout row 4 + the changelog in `review-findings.md`, fold current
behavior into `CONTEXT.md`, and move this design + its plan to `docs/shipped/`. **This also closes
all of Phase 2.**

## Execution

Subagent-driven (per superpowers:subagent-driven-development), like the prior Phase 2 specs.
