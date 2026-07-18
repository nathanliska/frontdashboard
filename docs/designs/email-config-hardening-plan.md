# Email Normalization + Production Config Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make email identity case-insensitive (normalize at the schema boundary + a `lower(email)`
unique index), bound display names, and make production configuration fail fast (environment enum +
secret/email validation) — closing finding #31 and the display-name slice of #14.

**Architecture:** Three independent slices. (1) Email: a `NormalizedEmail` Pydantic type on the four
auth request schemas + a functional unique index on `lower(email)` (model `__table_args__` for tests,
Alembic migration for real DBs). (2) Display-name bounds: a shared limit + normalizer on
`RegisterRequest`, and a length check in the `update_profile` handler. (3) Config: an `Environment`
`StrEnum` and a production-only `model_validator` on `Settings`.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2 / pydantic-settings, SQLAlchemy 2.0 async, Alembic,
argon2, pytest + pytest-asyncio (`asyncio_mode = "auto"`) via Testcontainers.

**Source spec:** `docs/designs/email-config-hardening-design.md`.

## Global Constraints

- **Email normalization is `.strip().lower()`** applied after `EmailStr` format validation, on all
  four request schemas (`RegisterRequest`, `LoginRequest`, `ResendVerificationRequest`,
  `PasswordResetRequest`). No router logic changes.
- **The DB uniqueness guarantee is a functional unique index `uq_users_email_lower` on
  `lower(email)`** — the model drops column-level `unique=True`; the migration drops the existing
  `uq_users_email` unique constraint and creates the functional index. Model and migration must stay
  consistent (tests build the index via `create_all`; the migration is the prod/dev-DB path).
- **The migration must abort loudly on pre-existing case-collisions** (never silently merge accounts).
- **`DISPLAY_NAME_MAX_LENGTH = 100`** — one shared constant (matches the `dashboard.name` limit).
- **`ProfileUpdate`'s error contract is preserved**: blank display name still returns the custom
  string-detail `422 "Display name cannot be empty"` from the handler; the existing
  `test_update_profile_rejects_blank_display_name` must stay green.
- **Production config checks run only when `environment == Environment.production`.** Development and
  test (repo-root `.env` has `ENVIRONMENT=development`) are unaffected; the test suite must stay green.
- Alembic migrations are hand-authored 12-char slugs with explicit `down_revision` chaining. Current
  head is `b5d8f0a2c4e6`.

---

### Task 1: Case-insensitive email identity

Normalize email on the four auth request schemas, replace the plain email uniqueness with a
`lower(email)` functional unique index (model + migration), and prove case-insensitive login,
case-variant duplicate rejection, and the DB backstop.

**Files:**
- Modify: `backend/app/schemas/auth.py` (add `NormalizedEmail`, apply to 4 schemas)
- Modify: `backend/app/models/user.py` (drop `unique=True`, add functional index)
- Create: `backend/alembic/versions/c7e0f2a4b6d8_case_insensitive_email.py`
- Modify: `backend/tests/test_auth.py` (normalization/login/dup/resend/reset + DB-index tests)

**Interfaces:**
- Produces: `NormalizedEmail` (an `Annotated[EmailStr, AfterValidator(_normalize_email)]`) exported
  from `app/schemas/auth.py`; the `Annotated`/`AfterValidator` imports Task 2 also relies on.
- Produces: the `users` unique index rename — no Python callers depend on it.

- [ ] **Step 1: Write the failing email tests**

Add to `backend/tests/test_auth.py`. The `IntegrityError` import and a `db_session` fixture are used
by the DB-index test (the file already imports from `sqlalchemy` and uses `db_session` elsewhere —
add `from sqlalchemy.exc import IntegrityError` near the top imports if not present, and
`from app.models.user import User` if not present):

```python
async def test_register_normalizes_email(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "Mixed@Example.COM ", "password": "password123", "display_name": "M"},
    )
    assert resp.status_code == 201
    assert resp.json()["email"] == "mixed@example.com"


async def test_login_is_case_insensitive(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "Case@Example.com", "password": "mypassword", "display_name": "C"},
    )
    token = app.state.email_verification_tokens["case@example.com"]
    await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})

    resp = await db_client.post(_LOGIN_URL, json={"email": "CASE@example.COM", "password": "mypassword"})
    assert resp.status_code == 200


async def test_register_rejects_case_variant_duplicate(db_client: AsyncClient) -> None:
    payload = {"email": "dupe@example.com", "password": "password123", "display_name": "D"}
    assert (await db_client.post(_REGISTER_URL, json=payload)).status_code == 201
    variant = {"email": "Dupe@Example.com", "password": "password123", "display_name": "D2"}
    assert (await db_client.post(_REGISTER_URL, json=variant)).status_code == 409


async def test_password_reset_request_is_case_insensitive(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "reset-ci@example.com", "password": "oldpassword", "display_name": "R"},
    )
    resp = await db_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "Reset-CI@Example.com"})
    assert resp.status_code == 204
    assert "reset-ci@example.com" in app.state.password_reset_tokens


async def test_email_uniqueness_is_case_insensitive_at_db(db_session: AsyncSession) -> None:
    db_session.add(User(email="dbcase@example.com", password_hash="x", display_name="A"))
    await db_session.flush()
    db_session.add(User(email="DBCase@Example.com", password_hash="x", display_name="B"))
    with pytest.raises(IntegrityError):
        await db_session.flush()
```

Add `import pytest` if the file doesn't already import it. Confirm the exact `app.state`
attribute names for captured tokens by reading `tests/conftest.py` (`reset_test_state`) — use
whatever it sets (e.g. `password_reset_tokens`); adjust the assertion to match.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_auth.py -k "case_insensitive or normalizes or case_variant" -v`
Expected: FAIL — `test_login_is_case_insensitive` gets 401 (mixed-case stored, exact lookup misses),
`test_register_rejects_case_variant_duplicate` gets 201 not 409, the DB test raises no `IntegrityError`
(plain unique allows different-case rows), and `test_register_normalizes_email` returns the mixed-case
email.

- [ ] **Step 3: Add the `NormalizedEmail` type and apply it**

In `backend/app/schemas/auth.py`, update the imports and add the type (place near the top, after
imports):

```python
from typing import Annotated

from pydantic import AfterValidator, BaseModel, EmailStr, Field, field_validator


def _normalize_email(v: str) -> str:
    return v.strip().lower()


NormalizedEmail = Annotated[EmailStr, AfterValidator(_normalize_email)]
```

Then change `email: EmailStr` → `email: NormalizedEmail` in `RegisterRequest`, `LoginRequest`,
`ResendVerificationRequest`, and `PasswordResetRequest`.

- [ ] **Step 4: Replace the model uniqueness with a functional index**

In `backend/app/models/user.py`, add `Index` and `func` to the sqlalchemy import, drop `unique=True`
from the email column, and add `__table_args__`:

```python
from sqlalchemy import DateTime, Index, String, func
```
```python
    email: Mapped[str] = mapped_column(String, nullable=False)
```
```python
    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)
```
(Place `__table_args__` inside the class, after the column definitions.)

- [ ] **Step 5: Write the Alembic migration**

Create `backend/alembic/versions/c7e0f2a4b6d8_case_insensitive_email.py`:

```python
"""case-insensitive email uniqueness

Revision ID: c7e0f2a4b6d8
Revises: b5d8f0a2c4e6
Create Date: 2026-07-17
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e0f2a4b6d8"
down_revision: str | Sequence[str] | None = "b5d8f0a2c4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dupes = bind.execute(
        sa.text(
            "SELECT lower(email) AS k, count(*) AS n "
            "FROM users GROUP BY lower(email) HAVING count(*) > 1"
        )
    ).fetchall()
    if dupes:
        keys = ", ".join(row.k for row in dupes)
        raise RuntimeError(
            "Cannot enforce case-insensitive email uniqueness: accounts differ only by case "
            f"({keys}). Resolve these manually before migrating."
        )

    bind.execute(sa.text("UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email))"))
    op.drop_constraint("uq_users_email", "users", type_="unique")
    op.create_index("uq_users_email_lower", "users", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index("uq_users_email_lower", table_name="users")
    op.create_unique_constraint("uq_users_email", "users", ["email"])
```

- [ ] **Step 6: Run the email tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_auth.py -v`
Expected: PASS — the four new integration tests + the DB-index test pass, and every pre-existing
auth test stays green (existing tests register lowercase emails, so normalization is a no-op for them).

- [ ] **Step 7: Lint**

Run: `cd backend && uv run ruff check app/schemas/auth.py app/models/user.py alembic/versions/c7e0f2a4b6d8_case_insensitive_email.py tests/test_auth.py && uv run ruff format --check app/schemas/auth.py app/models/user.py alembic/versions/c7e0f2a4b6d8_case_insensitive_email.py tests/test_auth.py`
Expected: clean (fix and re-run if not).

- [ ] **Step 8: Commit**

```bash
git add backend/app/schemas/auth.py backend/app/models/user.py backend/alembic/versions/c7e0f2a4b6d8_case_insensitive_email.py backend/tests/test_auth.py
git commit -m "feat(auth): normalize email identity and enforce case-insensitive uniqueness"
```

---

### Task 2: Display-name bounds

Give `RegisterRequest.display_name` schema-level normalization/bounds, and add a length bound to the
`update_profile` handler — preserving ProfileUpdate's existing string-detail error contract.

**Files:**
- Modify: `backend/app/schemas/auth.py` (`DISPLAY_NAME_MAX_LENGTH`, `DisplayName`, apply to `RegisterRequest`)
- Modify: `backend/app/routers/auth.py` (`update_profile` length check)
- Modify: `backend/tests/test_auth.py` (register + profile bound tests)

**Interfaces:**
- Consumes: the `Annotated`/`AfterValidator` imports added in Task 1.
- Produces: `DISPLAY_NAME_MAX_LENGTH` (int) exported from `app/schemas/auth.py`, imported by the router.

- [ ] **Step 1: Write the failing display-name tests**

Add to `backend/tests/test_auth.py`:

```python
async def test_register_rejects_blank_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "blankname@example.com", "password": "password123", "display_name": "   "},
    )
    assert resp.status_code == 422


async def test_register_rejects_overlong_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "longname@example.com", "password": "password123", "display_name": "x" * 101},
    )
    assert resp.status_code == 422


async def test_register_trims_display_name(db_client: AsyncClient) -> None:
    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "trimname@example.com", "password": "password123", "display_name": "  Bob  "},
    )
    assert resp.status_code == 201
    token = app.state.email_verification_tokens["trimname@example.com"]
    verify = await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})
    assert verify.json()["display_name"] == "Bob"


async def test_update_profile_rejects_overlong_display_name(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.patch(_PROFILE_URL, json={"display_name": "x" * 101})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Display name must be at most 100 characters"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_auth.py -k "display_name" -v`
Expected: FAIL — register currently accepts blank/overlong/untrimmed names (201, and the trim test
sees `"  Bob  "`), and profile accepts a 101-char name (200, no 422).

- [ ] **Step 3: Add the shared limit + `DisplayName` type**

In `backend/app/schemas/auth.py`, add (after the `NormalizedEmail` definition from Task 1):

```python
DISPLAY_NAME_MAX_LENGTH = 100


def _normalize_display_name(v: str) -> str:
    v = v.strip()
    if not v:
        raise ValueError("Display name cannot be empty")
    if len(v) > DISPLAY_NAME_MAX_LENGTH:
        raise ValueError(f"Display name must be at most {DISPLAY_NAME_MAX_LENGTH} characters")
    return v


DisplayName = Annotated[str, AfterValidator(_normalize_display_name)]
```

Change `RegisterRequest.display_name: str` → `display_name: DisplayName`.

- [ ] **Step 4: Add the length check to `update_profile`**

In `backend/app/routers/auth.py`, import the constant:

```python
from app.schemas.auth import (
    ...,
    DISPLAY_NAME_MAX_LENGTH,
    ...,
)
```
In `update_profile`, inside the existing `if body.display_name is not None:` block, after
`display_name = body.display_name.strip()` and the empty check, add:

```python
        if len(display_name) > DISPLAY_NAME_MAX_LENGTH:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Display name must be at most {DISPLAY_NAME_MAX_LENGTH} characters",
            )
```

- [ ] **Step 5: Run the display-name tests + the profile regression test**

Run: `cd backend && uv run pytest tests/test_auth.py -k "display_name or update_profile" -v`
Expected: PASS — the four new tests pass, and `test_update_profile_rejects_blank_display_name`
(the existing custom-message blank check) stays green.

- [ ] **Step 6: Lint**

Run: `cd backend && uv run ruff check app/schemas/auth.py app/routers/auth.py tests/test_auth.py && uv run ruff format --check app/schemas/auth.py app/routers/auth.py tests/test_auth.py`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add backend/app/schemas/auth.py backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "feat(auth): bound registration and profile display names"
```

---

### Task 3: Environment enum + fail-fast production config

Model `environment` as an enum and add a production-only validator that rejects a weak/placeholder
secret, a missing Resend key, and an undeliverable `email_from`. Update the one `_SECURE` consumer
and the env examples.

**Files:**
- Modify: `backend/app/config.py` (`Environment` enum, field, `_INSECURE_SECRETS`, `model_validator`)
- Modify: `backend/app/routers/auth.py` (`_SECURE` comparison)
- Create: `backend/tests/test_config.py`
- Modify: `.env.example`, `.env.prod.example` (locate exact paths; enum values + prod requirements)

**Interfaces:**
- Produces: `Environment` (`StrEnum`) and `settings.environment: Environment` from `app/config.py`.

- [ ] **Step 1: Write the failing config tests**

Create `backend/tests/test_config.py`:

```python
import pytest
from pydantic import ValidationError

from app.config import Settings

_BASE = {
    "_env_file": None,
    "database_url": "postgresql+asyncpg://u:p@localhost/db",
    "secret_key": "x" * 40,
}


def _make(**overrides) -> Settings:
    return Settings(**{**_BASE, **overrides})


def test_invalid_environment_rejected() -> None:
    with pytest.raises(ValidationError):
        _make(environment="prod")


def test_development_skips_production_checks() -> None:
    # weak secret + no email config is fine outside production
    _make(environment="development", secret_key="short", resend_api_key=None)


def test_production_requires_strong_secret_and_email() -> None:
    with pytest.raises(ValidationError):
        _make(environment="production", secret_key="short")


def test_production_requires_resend_key() -> None:
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key=None,
            email_from="FrontDashboard <noreply@example.com>",
        )


def test_production_rejects_default_email_from() -> None:
    with pytest.raises(ValidationError):
        _make(
            environment="production",
            resend_api_key="re_test",
            email_from="FrontDashboard <noreply@frontdashboard.local>",
        )


def test_valid_production_config_constructs() -> None:
    settings = _make(
        environment="production",
        secret_key="s" * 40,
        resend_api_key="re_test",
        email_from="FrontDashboard <noreply@example.com>",
    )
    assert settings.environment.value == "production"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_config.py -v`
Expected: FAIL — `environment` is a free string (invalid value accepted, no `ValidationError`), and no
production validator exists, so the production-invalid cases construct cleanly. `Environment` import
in the valid-config test also fails (`.value` on a str).

- [ ] **Step 3: Add the enum, placeholder set, and production validator**

In `backend/app/config.py`, update imports and the class:

```python
from enum import StrEnum

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    development = "development"
    production = "production"
    test = "test"


# Placeholder secrets shipped in example env files — never valid in production.
_INSECURE_SECRETS = frozenset({"changeme", "change_me", "CHANGE_ME_TO_A_LONG_RANDOM_SECRET"})
```

Change the field: `environment: Environment = Environment.development`. Add the validator (after the
existing `validate_frontend_base_url`):

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

- [ ] **Step 4: Update the `_SECURE` consumer**

In `backend/app/routers/auth.py`, import `Environment` and change:

```python
from app.config import Environment, settings
```
```python
_SECURE = settings.environment == Environment.production
```

- [ ] **Step 5: Run the config tests + confirm the app still imports**

Run: `cd backend && uv run pytest tests/test_config.py tests/test_auth.py -q`
Expected: PASS — config tests pass, and the full auth suite still passes (dev `.env` has
`ENVIRONMENT=development`, so the production validator is skipped at import).

- [ ] **Step 6: Update the env examples**

Locate the example env files (`git ls-files | grep -E '\.env.*example'`). In each:
- Add a comment listing valid `ENVIRONMENT` values: `development`, `production`, `test`.
- In the **production** example, set `SECRET_KEY=CHANGE_ME_TO_A_LONG_RANDOM_SECRET` (in
  `_INSECURE_SECRETS`, so an un-edited copy fails the check) and add a comment noting production
  requires a ≥32-char `SECRET_KEY`, a `RESEND_API_KEY`, and a deliverable `EMAIL_FROM`.

- [ ] **Step 7: Lint**

Run: `cd backend && uv run ruff check app/config.py app/routers/auth.py tests/test_config.py && uv run ruff format --check app/config.py app/routers/auth.py tests/test_config.py`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add backend/app/config.py backend/app/routers/auth.py backend/tests/test_config.py .env.example .env.prod.example
git commit -m "feat(config): enum-validate environment and fail fast on insecure production config"
```

(Adjust the staged env-example paths to whatever `git ls-files` reported.)

---

## Self-Review

- **Spec coverage:** email normalization (T1 schema) + `lower(email)` uniqueness (T1 model +
  migration); display-name bounds (T2, register schema-level + profile handler-level preserving the
  error contract); environment enum + production validator + env examples (T3). Every design section
  maps to a task.
- **Type consistency:** `NormalizedEmail`/`DisplayName`/`DISPLAY_NAME_MAX_LENGTH` defined in T1/T2 and
  consumed where stated; `Environment` defined in T3 and used by `_SECURE`. `AfterValidator`/`Annotated`
  imports added in T1, reused in T2.
- **Task boundaries:** each task ends green and independently reviewable — T1 (email identity), T2
  (display names), T3 (config). T1 and T2 both touch `schemas/auth.py` but run sequentially with a
  commit between, and T2's Interfaces block notes the shared imports.
- **Contract preservation:** ProfileUpdate blank-name test stays green (handler keeps its custom
  message); the length check adds a parallel custom-message 422. Production validators are gated on
  `environment == production`, so dev/test (and the whole suite) are unaffected.
- **No placeholders:** every code step carries complete code and an exact command with expected output.
- **Verify-before-fix caveats flagged:** the exact `app.state` token-capture attribute names and the
  env-example file paths are to be confirmed from `conftest.py` / `git ls-files` in-task rather than
  assumed.
