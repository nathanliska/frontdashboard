# Design — Argon2 off the event loop (#13) + close the login timing oracle (#43)

**Date:** 2026-07-17
**Status:** ✅ Shipped 2026-07-17 (`fed8642`, `f37a9e1`, test hardening `9931000`). Phase 2 spec 3 of 4.
**Findings:** #13 (move Argon2 work off the async event loop), #43 (remove the login
user-enumeration timing oracle). They share one code path — the hashing module and the same five
call sites — so they ship together, per #43's own note.

**Not in this doc.** The remaining Phase 2 spec is #31 (email normalization + config validation),
independent and separate. Specs 1 (session revocation) and 2 (#1, auth-boundary reset) shipped.

## Theme

We store passwords, so we hash them with Argon2 — the OWASP-recommended, memory-hard password hash
(deliberately ~64 MiB and ~50-100 ms per operation, which is what makes a leaked `password_hash`
column uncrackable). That expense is correct and non-negotiable. But two things follow from running
it wrong:

- **#13** — the hash/verify calls run **synchronously** in async request handlers, so each one blocks
  the single event-loop thread. An auth burst stalls every unrelated API request and every SSE
  stream. This is intrinsic to any proper password hash, not to Argon2; the fix is to run it in a
  bounded thread pool.
- **#43** — `login` short-circuits on an unknown email (`if not user or not verify_password(...)`),
  so a nonexistent account answers in ~0 ms while a real one pays a full verify. Identical response
  body, very different timing → reliable account enumeration. The fix is to always pay one verify.

## What is actually true today (verified in code)

- **`hashing.py` is fully synchronous** (`app/auth/hashing.py`): a module-level
  `_ph = PasswordHasher()` with `hash_password`/`verify_password` calling `_ph.hash`/`_ph.verify`
  directly. Argon2 params are library defaults (`time_cost=3`, `memory_cost=64 MiB`,
  `parallelism=4`).
- **Exactly five call sites, all in async handlers** (`app/routers/auth.py`): `register` (`:230`
  hash), `login` (`:363` verify), `confirm_password_reset` (`:346` hash), `change_password` (`:466`
  verify, `:478` hash). A repo-wide grep found **no other callers** of these functions — no seed
  script, CLI, or test helper hashes directly (test fixtures set `password_hash="x"` literally or
  register through the API). So the async conversion is contained to these five awaits.
- **The 403 branch is not an enumeration oracle.** `login` returns `403 Email verification required`
  only *after* a successful password verify (`:363` guards `:364`), so reaching it requires valid
  credentials — an attacker cannot probe it without already knowing the password. #43 is purely the
  miss-path timing gap.
- **anyio is available** (Starlette dependency, 4.13) and already used across the async stack.

## Design

### 1. `app/auth/hashing.py` — async, thread-offloaded, bounded

- `hash_password` and `verify_password` become **`async`**. Each runs its Argon2 call through
  `anyio.to_thread.run_sync(fn, arg, limiter=_argon2_limiter)`. The existing
  `VerifyMismatchError`/`VerificationError` → `False` handling stays inside the sync function handed
  to the thread.
- **`_argon2_limiter = anyio.CapacityLimiter(settings.argon2_max_concurrency)`** — a module-level
  singleton, so peak concurrent Argon2 work is bounded to N (≈ N × 64 MiB memory, and it keeps a
  small-core CPU busy without thrashing, since `parallelism=4` already saturates 2-4 cores at low N).
  When the limiter is full, further auth requests **queue** while the event loop and the rest of the
  app stay responsive — graceful degradation instead of a global stall. anyio 4's `CapacityLimiter`
  is backend-agnostic until used, so eager module-level construction is safe; if it ever raises under
  a backend, fall back to lazy construction behind a module-level accessor (implementation detail).
- **`_DUMMY_HASH = _ph.hash(...)`** computed once at module load, for the login miss path. Uses the
  same `_ph`, so its verify cost always matches real hashes (and follows stored params on verify).
  Exported (or exposed via a helper) so the router can use it.

### 2. `app/routers/auth.py` — five awaits, and the login restructure

- `register`, `confirm_password_reset`, `change_password`: add `await` to their hash/verify calls
  (no logic change).
- **`login` restructured to always perform exactly one verify** (the #43 fix):
  ```python
  result = await db.execute(select(User).where(User.email == body.email, User.deleted_at.is_(None)))
  user = result.scalar_one_or_none()
  password_hash = user.password_hash if user else _DUMMY_HASH
  password_ok = await verify_password(body.password, password_hash)
  if not user or not password_ok:
      raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
  if user.email_verified_at is None:
      raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email verification required")
  await _create_session(user, response, db)
  await db.commit()
  return UserResponse.model_validate(user)
  ```
  Both failure paths (no user, wrong password) now pay one Argon2 verify and return an identical 401.
  Session creation cost is only on the success path (requires the correct password — not an
  enumeration vector).

### 3. `app/config.py` — one setting

- `argon2_max_concurrency: int = 4` (peak ≈ 256 MiB; overridable up for a beefier deploy). Argon2
  security params stay at library defaults.

## Testing (pytest, Testcontainers)

- **#43 — the load-bearing test:** with `verify_password` spied/monkeypatched, assert that
  `POST /login` with a **nonexistent** email still calls `verify_password` exactly once (the oracle
  is closed — this fails against today's short-circuit), and that the nonexistent-email response and
  the wrong-password response are identical (same 401 status and body). No timing assertions.
- **#13 — correctness after the async conversion:** `await hash_password(pw)` then
  `await verify_password(pw, h)` → `True`; wrong password → `False`; assert both functions return
  coroutines. The off-the-loop property holds by construction (`to_thread`); no flaky timing test.
- Existing auth tests (`test_auth.py`) must stay green — the five call sites now await, but behavior
  (status codes, bodies, flows) is unchanged; login's success and wrong-password cases are covered
  already and should continue to pass.

## Out of scope / deferred

- **Argon2 parameter tuning + concurrent-auth load test** (the finding's literal proposal): the
  defaults are OWASP-reasonable and load-test infrastructure is disproportionate at household scale.
  `memory_cost` interacts with the limiter's memory budget, so if a future deploy needs different
  sizing, revisit both together.
- **A limiter slot-wait timeout → 503** under a distributed flood: login's per-IP `10/minute` rate
  limit is the first line of defense; an explicit timeout is a possible future hardening, not needed
  now.
- **Registration / password-reset-request enumeration** are separate concerns; #43 is scoped to the
  login timing oracle.

## Execution

Subagent-driven (per superpowers:subagent-driven-development), like the prior Phase 2 specs.
