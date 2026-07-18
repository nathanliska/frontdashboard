# Low-Severity Security Batch (#49/#50/#51) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small, independent backend hardenings from the Phase 2 security review: keep
`last_used_at` fresh on access re-issue (#49), make `ENVIRONMENT` explicit + log posture (#50), and
turn a register unique-collision 500 into a 409 (#51).

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async, pydantic-settings, pytest +
pytest-asyncio (`asyncio_mode = "auto"`) via Testcontainers.

**Source spec:** `docs/designs/low-batch-hardening-design.md`.

## Global Constraints

- Each fix is independent and keeps existing behavior otherwise; existing tests stay green.
- #50 removes the `environment` default → `Settings()` fails fast if `ENVIRONMENT` is unset. All four
  `.env` files already set it; no config test may rely on the default.
- #51's 409 must be identical (status + body) to the existing pre-check 409 `"Email already registered"`.

---

### Task 1: #49 — bump `last_used_at` when an access token is re-issued

**Files:**
- Modify: `backend/app/routers/auth.py` (`update_profile`, `change_password`)
- Modify: `backend/tests/test_auth.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_auth.py` (the file already imports `select`, `UserSession`, `set_csrf`,
`_PROFILE_URL`, and uses `db_session`):

```python
async def test_profile_update_bumps_session_last_used_at(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    from datetime import UTC, datetime, timedelta

    session = (await db_session.execute(select(UserSession))).scalars().one()
    old = datetime.now(UTC) - timedelta(hours=1)
    session.last_used_at = old
    await db_session.flush()

    set_csrf(auth_client)
    resp = await auth_client.patch(_PROFILE_URL, json={"display_name": "Bumped"})
    assert resp.status_code == 200

    await db_session.refresh(session)
    assert session.last_used_at is not None
    assert session.last_used_at > old
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_auth.py::test_profile_update_bumps_session_last_used_at -v`
Expected: FAIL — `update_profile` does not touch `last_used_at`, so it stays at `old`.

- [ ] **Step 3: Bump `last_used_at` in both handlers**

In `backend/app/routers/auth.py`, in `update_profile`, immediately before its `await db.commit()`
(currently line ~458):

```python
    session.last_used_at = datetime.now(UTC)
    await db.commit()
```

In `change_password`, immediately before its `await db.commit()` (currently line ~488):

```python
    session.last_used_at = datetime.now(UTC)
    await db.commit()
```

(`datetime` and `UTC` are already imported in this module.)

- [ ] **Step 4: Run the test + the profile/password suites**

Run: `cd backend && uv run pytest tests/test_auth.py -k "profile or password" -v`
Expected: PASS — the new test passes; existing profile/password tests stay green.

- [ ] **Step 5: Lint + commit**

```bash
cd backend && uv run ruff check app/routers/auth.py tests/test_auth.py && uv run ruff format --check app/routers/auth.py tests/test_auth.py
git add backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "fix(auth): refresh session last_used_at when re-issuing the access cookie"
```

---

### Task 2: #50 — require `ENVIRONMENT` explicitly + log the security posture

**Files:**
- Modify: `backend/app/config.py` (drop the `environment` default)
- Modify: `backend/app/main.py` (startup posture log)
- Modify: `backend/tests/test_config.py` (require-explicit test + `_BASE`)

- [ ] **Step 1: Write the failing test**

In `backend/tests/test_config.py`, add `"environment": "development"` to the shared `_BASE` dict (so
the existing tests, which already pass `environment` explicitly, are unaffected), and add:

```python
def test_environment_is_required() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, database_url="postgresql+asyncpg://u:p@localhost/db", secret_key="x" * 40)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_config.py::test_environment_is_required -v`
Expected: FAIL — `environment` still defaults to `development`, so `Settings(...)` constructs without error.

- [ ] **Step 3: Drop the default**

In `backend/app/config.py`, change:

```python
    environment: Environment = Environment.development
```
to:
```python
    environment: Environment
```

- [ ] **Step 4: Add the startup posture log**

In `backend/app/main.py`, import `Environment` (alongside the existing `from app.config import settings`):

```python
from app.config import Environment, settings
```

At the top of the `lifespan` body, before the reaper task is created, add:

```python
    logger = logging.getLogger("app")
    if settings.environment == Environment.production:
        logger.info("Starting: environment=production (Secure cookies ON, production config validated)")
    else:
        logger.warning(
            "Starting: environment=%s (Secure cookies OFF, production validation skipped)",
            settings.environment.value,
        )
```

- [ ] **Step 5: Run the config tests + a broad import check**

Run: `cd backend && uv run pytest tests/test_config.py tests/test_auth.py -q`
Expected: PASS — `test_environment_is_required` passes; every other config/auth test stays green (the
suite loads the dev `.env` with `ENVIRONMENT=development`, so `Settings()` at import still succeeds).

- [ ] **Step 6: Lint + commit**

```bash
cd backend && uv run ruff check app/config.py app/main.py tests/test_config.py && uv run ruff format --check app/config.py app/main.py tests/test_config.py
git add backend/app/config.py backend/app/main.py backend/tests/test_config.py
git commit -m "feat(config): require ENVIRONMENT explicitly and log the startup security posture"
```

---

### Task 3: #51 — `register` returns 409 (not 500) on a unique-index collision

**Files:**
- Modify: `backend/app/routers/auth.py` (`register`)
- Modify: `backend/tests/test_auth.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_auth.py` (uses `db_session`, `User`, `_REGISTER_URL`):

```python
async def test_register_collision_returns_409_not_500(db_client: AsyncClient, db_session: AsyncSession) -> None:
    # A mixed-case row inserted directly (bypassing schema normalization) is missed by register's
    # exact-match pre-check but caught by the lower(email) unique index — the IntegrityError backstop.
    db_session.add(User(email="Edge@Example.com", password_hash="x", display_name="Edge"))
    await db_session.flush()

    resp = await db_client.post(
        _REGISTER_URL,
        json={"email": "edge@example.com", "password": "password123", "display_name": "Edge2"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Email already registered"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_auth.py::test_register_collision_returns_409_not_500 -v`
Expected: FAIL — the flush raises an uncaught `IntegrityError` → `500`, not `409`.

- [ ] **Step 3: Catch the collision**

In `backend/app/routers/auth.py`, add the import near the other sqlalchemy imports:

```python
from sqlalchemy.exc import IntegrityError
```

In `register`, replace:

```python
    db.add(user)
    await db.flush()
```
with:
```python
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
        ) from None
```

- [ ] **Step 4: Run the register tests**

Run: `cd backend && uv run pytest tests/test_auth.py -k "register" -v`
Expected: PASS — the collision test returns `409`; existing register tests (normal create, pre-check
duplicate, validation) stay green.

- [ ] **Step 5: Lint + commit**

```bash
cd backend && uv run ruff check app/routers/auth.py tests/test_auth.py && uv run ruff format --check app/routers/auth.py tests/test_auth.py
git add backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "fix(auth): return 409 not 500 when a register email collides with the unique index"
```

---

## Self-Review

- **Spec coverage:** #49 (Task 1, both re-issue handlers), #50 (Task 2, drop default + startup log +
  require-explicit test), #51 (Task 3, IntegrityError → 409). Each design section maps to a task.
- **Type/behavior consistency:** #49 uses the already-imported `datetime.now(UTC)`; #51's 409 body
  matches the pre-check exactly; #50 adds `Environment` to the `main.py` import and `_BASE`.
- **Task boundaries:** each task ends green and independently reviewable; no cross-task dependency.
- **Blast-radius check (#50):** all four `.env` files set `ENVIRONMENT`; `_BASE` gains an explicit
  `environment` so existing config tests are unaffected; the new test constructs `Settings` without it.
- **No placeholders:** every code step carries complete code and an exact command with expected output.
