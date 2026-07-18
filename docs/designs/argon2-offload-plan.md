# Argon2 Off the Event Loop + Login Timing Oracle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Argon2 hashing/verification off the async event loop under a bounded concurrency
limiter (#13), and remove the login user-enumeration timing oracle by always paying exactly one
Argon2 verify (#43).

**Architecture:** `app/auth/hashing.py` becomes async — `hash_password`/`verify_password` run their
Argon2 call through `anyio.to_thread.run_sync(..., limiter=_argon2_limiter)`, where
`_argon2_limiter = anyio.CapacityLimiter(settings.argon2_max_concurrency)` bounds peak concurrent
hashing (memory-DoS protection). The five call sites in `app/routers/auth.py` `await` the now-async
functions. `login` is then restructured to always verify against a module-level `_DUMMY_HASH` on the
miss path so a nonexistent email and a wrong password are timing- and body-identical.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async, argon2-cffi, anyio 4.13, pytest +
pytest-asyncio (`asyncio_mode = "auto"`) via Testcontainers.

**Source spec:** `docs/designs/argon2-offload-design.md`.

## Global Constraints

- **Argon2 security params stay at library defaults** (`time_cost=3`, `memory_cost=64 MiB`,
  `parallelism=4`) — do not tune them in this work.
- **`argon2_max_concurrency` default is `4`** (peak ≈ 256 MiB), overridable via env.
- The limiter is a **single module-level `anyio.CapacityLimiter`** shared by both hash and verify —
  not one per call.
- **`_DUMMY_HASH` is produced by the same `_ph`** used for real hashes, computed once at module load,
  so its verify cost tracks real hashes.
- Both login failure paths (unknown email, wrong password) must return an **identical 401** — same
  status and same body `{"detail": "Invalid credentials"}` — and both must perform **exactly one**
  Argon2 verify.
- No timing assertions in tests (flaky by nature); prove #43 via a verify-call spy instead.
- All existing auth behavior (status codes, bodies, flows) is unchanged; existing tests stay green.

---

### Task 1: Move Argon2 off the event loop (#13)

Convert the hashing module to async under a bounded limiter, add the config setting, and `await` the
five call sites. `login`'s existing short-circuit is preserved here (it becomes `if not user or not
await verify_password(...)`); the oracle is closed separately in Task 2. At the end of this task the
full backend suite is green.

**Files:**
- Modify: `backend/app/config.py` (add one setting)
- Modify: `backend/app/auth/hashing.py` (async conversion + limiter)
- Modify: `backend/app/routers/auth.py` (5 `await`s at the hash/verify call sites)
- Create: `backend/tests/test_hashing.py`

**Interfaces:**
- Consumes: `settings.argon2_max_concurrency: int` (added in this task).
- Produces:
  - `async def hash_password(password: str) -> str`
  - `async def verify_password(password: str, hashed: str) -> bool`
  - Module-level `_argon2_limiter: anyio.CapacityLimiter` in `app/auth/hashing.py`.

- [ ] **Step 1: Write the failing hashing unit test**

Create `backend/tests/test_hashing.py`:

```python
import inspect

from app.auth.hashing import hash_password, verify_password


async def test_hash_and_verify_round_trip() -> None:
    hashed = await hash_password("correct horse battery staple")
    assert hashed != "correct horse battery staple"
    assert await verify_password("correct horse battery staple", hashed) is True


async def test_verify_rejects_wrong_password() -> None:
    hashed = await hash_password("correct horse battery staple")
    assert await verify_password("wrong password", hashed) is False


def test_hash_and_verify_are_coroutine_functions() -> None:
    assert inspect.iscoroutinefunction(hash_password)
    assert inspect.iscoroutinefunction(verify_password)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_hashing.py -v`
Expected: FAIL — `hash_password`/`verify_password` are still sync, so `await hash_password(...)`
raises `TypeError: object str can't be used in 'await' expression` and
`iscoroutinefunction` returns `False`.

- [ ] **Step 3: Add the config setting**

In `backend/app/config.py`, add to the `Settings` class alongside the other auth settings (e.g. just
after `password_reset_expire_hours`):

```python
    # Peak concurrent Argon2 hash/verify operations (each ~64 MiB). Bounds memory under an
    # auth burst; excess auth requests queue while the event loop stays responsive (finding #13).
    argon2_max_concurrency: int = 4
```

- [ ] **Step 4: Rewrite the hashing module async**

Replace the entire contents of `backend/app/auth/hashing.py` with:

```python
import anyio
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

from app.config import settings

_ph = PasswordHasher()

# One shared limiter bounds peak concurrent Argon2 work (each op ~64 MiB, and parallelism=4
# already saturates a few cores at low N). When full, further auth requests queue instead of
# stalling the event loop (finding #13).
_argon2_limiter = anyio.CapacityLimiter(settings.argon2_max_concurrency)


def _hash(password: str) -> str:
    return _ph.hash(password)


def _verify(password: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, password)
        return True
    except (VerifyMismatchError, VerificationError):
        return False


async def hash_password(password: str) -> str:
    return await anyio.to_thread.run_sync(_hash, password, limiter=_argon2_limiter)


async def verify_password(password: str, hashed: str) -> bool:
    return await anyio.to_thread.run_sync(_verify, password, hashed, limiter=_argon2_limiter)
```

- [ ] **Step 5: Run the hashing test to verify it passes**

Run: `cd backend && uv run pytest tests/test_hashing.py -v`
Expected: PASS (all three tests).

- [ ] **Step 6: Add `await` to the five call sites in `app/routers/auth.py`**

Four are pure mechanical `await` additions; `login` keeps its short-circuit but the verify becomes
awaited.

`register` (currently line ~230):
```python
        password_hash=await hash_password(body.password),
```

`confirm_password_reset` (currently line ~346):
```python
    user.password_hash = await hash_password(body.new_password)
```

`login` (currently lines ~361-364) — await the verify, keep the existing structure for now:
```python
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    if not user or not await verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
```

`change_password` (currently lines ~466 and ~478):
```python
    if not await verify_password(body.current_password, current_user.password_hash):
```
```python
    current_user.password_hash = await hash_password(body.new_password)
```

- [ ] **Step 7: Run the full backend suite to verify nothing regressed**

Run: `cd backend && uv run pytest tests/test_auth.py tests/test_hashing.py -v`
Expected: PASS — every existing auth test (register, login, wrong-password, verification-required,
password reset/change, session revocation) stays green now that the call sites await.

- [ ] **Step 8: Commit**

```bash
git add backend/app/config.py backend/app/auth/hashing.py backend/app/routers/auth.py backend/tests/test_hashing.py
git commit -m "perf(auth): run Argon2 off the event loop under a bounded limiter"
```

---

### Task 2: Close the login timing oracle (#43)

Restructure `login` so both failure paths pay exactly one Argon2 verify against an identical-cost
hash, closing the user-enumeration timing side-channel. Add the `_DUMMY_HASH` the miss path verifies
against.

**Files:**
- Modify: `backend/app/auth/hashing.py` (add `_DUMMY_HASH`)
- Modify: `backend/app/routers/auth.py` (restructure `login`)
- Modify: `backend/tests/test_auth.py` (add two tests)

**Interfaces:**
- Consumes: `hash_password`/`verify_password` (async, from Task 1).
- Produces: module-level `_DUMMY_HASH: str` in `app/auth/hashing.py`, imported by the router.

- [ ] **Step 1: Write the failing timing-oracle tests**

Add to `backend/tests/test_auth.py` (helpers `_REGISTER_URL`, `_LOGIN_URL`, `_VERIFY_EMAIL_URL` and
`app.state.email_verification_tokens` are already imported/used in this file):

```python
async def test_login_nonexistent_email_still_performs_verify(db_client: AsyncClient, monkeypatch) -> None:
    from app.routers import auth as auth_router

    calls: list[tuple[str, str]] = []
    original = auth_router.verify_password

    async def spy(password: str, hashed: str) -> bool:
        calls.append((password, hashed))
        return await original(password, hashed)

    monkeypatch.setattr(auth_router, "verify_password", spy)

    resp = await db_client.post(_LOGIN_URL, json={"email": "ghost@example.com", "password": "whatever"})
    assert resp.status_code == 401
    # The oracle is closed: a miss must still pay exactly one verify (against the dummy hash).
    assert len(calls) == 1


async def test_login_unknown_and_wrong_password_are_indistinguishable(db_client: AsyncClient) -> None:
    await db_client.post(
        _REGISTER_URL,
        json={"email": "real@example.com", "password": "correctpassword", "display_name": "R"},
    )
    token = app.state.email_verification_tokens["real@example.com"]
    await db_client.post(_VERIFY_EMAIL_URL, json={"token": token})

    unknown = await db_client.post(_LOGIN_URL, json={"email": "ghost@example.com", "password": "x"})
    wrong = await db_client.post(_LOGIN_URL, json={"email": "real@example.com", "password": "wrongpassword"})

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()
```

- [ ] **Step 2: Run the tests to verify the load-bearing one fails**

Run: `cd backend && uv run pytest tests/test_auth.py::test_login_nonexistent_email_still_performs_verify tests/test_auth.py::test_login_unknown_and_wrong_password_are_indistinguishable -v`
Expected: `test_login_nonexistent_email_still_performs_verify` FAILS — against Task 1's short-circuit,
a nonexistent email never reaches `verify_password`, so `len(calls) == 0`. (The indistinguishable-body
test may already pass, since both paths return the same 401 today — it locks the behavior in.)

- [ ] **Step 3: Add `_DUMMY_HASH` to the hashing module**

In `backend/app/auth/hashing.py`, add after the `_ph = PasswordHasher()` line:

```python
# Verified against on the login miss path so an unknown email pays the same Argon2 cost as a
# real one — closes the user-enumeration timing oracle (finding #43). Uses `_ph`, so its verify
# cost always matches real hashes.
_DUMMY_HASH = _ph.hash("frontdashboard-login-timing-equalizer")
```

- [ ] **Step 4: Restructure `login` to always verify once**

In `backend/app/routers/auth.py`, add `_DUMMY_HASH` to the hashing import:

```python
from app.auth.hashing import _DUMMY_HASH, hash_password, verify_password
```

Replace the `login` body's lookup + credential check (currently the `result`/`user`/`if not user`
block) with:

```python
    result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
    user = result.scalar_one_or_none()
    password_hash = user.password_hash if user else _DUMMY_HASH
    password_ok = await verify_password(body.password, password_hash)
    if not user or not password_ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required")
```

(The `_create_session` / `commit` / `return` tail of `login` is unchanged.)

- [ ] **Step 5: Run the new tests plus the login regression tests**

Run: `cd backend && uv run pytest tests/test_auth.py -k "login" -v`
Expected: PASS — both new tests plus `test_login`, `test_login_wrong_password`,
`test_login_requires_email_verification` (a real user with the wrong password still 401s; a verified
user with the right password still logs in; an unverified user still gets 403 only after a successful
verify).

- [ ] **Step 6: Commit**

```bash
git add backend/app/auth/hashing.py backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "fix(auth): close login user-enumeration timing oracle"
```

---

## Self-Review

- **Spec coverage:** #13 → Task 1 (async offload + limiter + config + awaits). #43 → Task 2 (login
  single-verify against `_DUMMY_HASH`). Config setting, `_DUMMY_HASH` home in `hashing.py`, spy-based
  non-flaky #43 test, and "existing tests stay green" verification steps are all present. Out-of-scope
  items (param tuning/load test, slot-wait timeout→503, registration/reset enumeration) are correctly
  absent.
- **Type consistency:** `hash_password`/`verify_password` are `async` from Task 1 and every call site
  awaits them; `_argon2_limiter` and `_DUMMY_HASH` are module-level in `hashing.py`; `login`'s
  `password_hash`/`password_ok` locals are consistent between the restructure and the tests.
- **Task boundaries:** Task 1 ends green (all call sites awaited); Task 2 ends green (oracle closed).
  Each is independently reviewable against one finding.
- **No placeholders:** every code step carries complete code and an exact command with expected output.
