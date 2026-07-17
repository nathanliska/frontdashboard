# Session Revocation Implementation Plan

**Status:** ✅ Shipped 2026-07-17 (`22c9dfd`, `54f7572`, `4089d88`, `dfd8234`, `f182ea2`). See the design doc's "Deviations from this design (as shipped)" for where execution diverged (Tasks 1+2 merged, a mid-plan dependency refactor, three insensitive tests rewritten, a frontend CSRF fix added).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/shipped/session-revocation-design.md`. Read it for rationale; this plan is the how.

**Goal:** Give the app a real session — one row per login, stable across refresh rotation — so that
credentials can be revoked per device, token reuse can be detected, and SSE streams stop when their
session dies (#6, #7, #8's authorization half, #44).

**Architecture:** A new `sessions` table becomes the unit of authority. The access JWT carries a
`sid`; every authenticated request joins `sessions` in the lookup it already performs, so a revoked
session 401s immediately. Refresh rotation becomes an atomic `UPDATE … RETURNING` with a 10s grace
window for the multi-tab stampede. SSE streams revalidate their session on a deadline (the
guarantee) and are dropped in-process on revocation (a latency optimisation that is explicitly not
load-bearing).

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async, Alembic, PostgreSQL 16, pytest +
Testcontainers, `uv`.

## Global Constraints

- **Model class is `UserSession`, table is `sessions`.** Never name the class `Session` — it collides
  with SQLAlchemy's `Session` in the same import namespace.
- **Grace window is exactly 10 seconds.** `_GRACE_WINDOW = timedelta(seconds=10)`.
- **Revalidation interval is exactly 30 seconds.** `_REVALIDATE_EVERY = timedelta(seconds=30)`.
- **Every non-GET route must add `_csrf: None = Depends(require_csrf)`** (`backend/CLAUDE.md`).
- **A new model module must be imported in BOTH `alembic/env.py` AND `tests/conftest.py`**
  (`backend/CLAUDE.md`) or it is invisible to autogenerate and to test table creation.
- **Migration style:** hand-authored 12-char slug, `from __future__ import annotations`,
  `revision`/`down_revision` typed `str | Sequence[str] | None`, explicit chaining.
  **This migration chains from `a3f7c2e9d1b4`** (current head).
- **Tests never exercise migrations** — schema comes from `Base.metadata.create_all`. Model and
  migration must be kept in step by hand.
- **`revoke_session()` is the only way a session dies.** Every trigger routes through it.
- **No `Co-Authored-By` / attribution trailer in commits.** Conventional Commit subjects.
- Run `make lint` and `make test` before claiming any task done. Backend pytest **needs Docker**.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `backend/app/models/session.py` | **Create.** `UserSession` model — one row per login. |
| `backend/app/models/refresh_token.py` | **Modify.** Add `session_id`, `revoked_at`; drop dead metadata; rebuild index. |
| `backend/app/services/sessions.py` | **Create.** The whole session lifecycle: start, rotate (atomic + grace), revoke. The only module that writes `sessions`. |
| `backend/app/services/password_reset.py` | **Create.** Atomic reset-token consume. Separate from `sessions.py` — a reset token is not a session; separate from the router so the race can be driven below HTTP. |
| `backend/alembic/versions/b5d8f0a2c4e6_add_sessions.py` | **Create.** The migration. |
| `backend/alembic/env.py` | **Modify.** Import the new model. |
| `backend/app/auth/tokens.py` | **Modify.** `sid` claim. |
| `backend/app/auth/dependencies.py` | **Modify.** Enforce `sid` + live session per request. |
| `backend/app/routers/auth.py` | **Modify.** Delegate to the service; CSRF + rate limit on `/refresh`; revoke on password change. |
| `backend/app/sse/manager.py` | **Modify.** `session_id` on `_Client`, `REVOKED_SENTINEL`, `disconnect_session`. |
| `backend/app/routers/sse.py` | **Modify.** Injected `revalidate`, deadline check. |
| `backend/tests/conftest.py` | **Modify.** Import the model; add the `concurrent_sessions` fixture. |
| `backend/tests/test_sessions_concurrency.py` | **Create.** The race tests. The only tests that really commit. |

`app/services/sessions.py` is a new module rather than more code in `routers/auth.py` (already ~510
lines) because the SSE router needs `session_is_live` too — putting it in the auth router would make
SSE import from a router.

---

## Task 1: `sessions` table

**Files:**
- Create: `backend/app/models/session.py`
- Create: `backend/alembic/versions/b5d8f0a2c4e6_add_sessions.py`
- Modify: `backend/app/models/refresh_token.py`
- Modify: `backend/alembic/env.py`
- Modify: `backend/tests/conftest.py:29-38` (model imports)
- Test: `backend/tests/test_sessions_concurrency.py` (created here, filled in Task 3)

**Interfaces:**
- Consumes: nothing.
- Produces: `UserSession` with fields `id: uuid.UUID`, `user_id: uuid.UUID`,
  `created_at: datetime`, `last_used_at: datetime | None`, `revoked_at: datetime | None`,
  `device_name: str | None`, `ip_hash: str | None`, `user_agent_hash: str | None`.
  `RefreshToken` gains `session_id: uuid.UUID` and `revoked_at: datetime | None`, and **loses**
  `revoked`, `device_name`, `ip_hash`, `user_agent_hash`, `last_used_at`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sessions_concurrency.py`.

> **`asyncio_mode = "auto"` (`pyproject.toml`) — do NOT add `@pytest.mark.asyncio`.** `test_auth.py`
> declares plain `async def test_...`; follow that.

```python
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User


async def _make_user(db: AsyncSession) -> User:
    user = User(
        email=f"session-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name="Session Test",
        email_verified_at=datetime.now(UTC),
    )
    db.add(user)
    await db.flush()
    return user


async def test_session_row_holds_a_refresh_token(db_session: AsyncSession) -> None:
    user = await _make_user(db_session)
    session = UserSession(user_id=user.id)
    db_session.add(session)
    await db_session.flush()

    db_session.add(
        RefreshToken(
            session_id=session.id,
            user_id=user.id,
            token_hash="hash-1",
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    await db_session.flush()

    stored = (
        await db_session.execute(select(RefreshToken).where(RefreshToken.session_id == session.id))
    ).scalar_one()
    assert stored.revoked_at is None
    assert session.revoked_at is None
    assert session.last_used_at is None


async def test_deleting_a_session_cascades_to_its_tokens(db_session: AsyncSession) -> None:
    user = await _make_user(db_session)
    session = UserSession(user_id=user.id)
    db_session.add(session)
    await db_session.flush()
    db_session.add(
        RefreshToken(
            session_id=session.id,
            user_id=user.id,
            token_hash="hash-2",
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    await db_session.flush()

    await db_session.delete(session)
    await db_session.flush()

    remaining = (
        await db_session.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))
    ).scalars().all()
    assert remaining == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.session'`

- [ ] **Step 3: Create the model**

`backend/app/models/session.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserSession(Base):
    """One row per login. Stable across refresh-token rotation, so it is the thing
    that can be named, revoked, and checked — which a rotating token cannot be.

    Named UserSession, not Session, to avoid colliding with SQLAlchemy's Session.

    Deliberately has no expires_at: a session's life is already bounded by its
    refresh token (7d), and a second expiry to keep in sync with the first would
    be a source of drift, not safety.
    """

    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_live", "user_id", "revoked_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    device_name: Mapped[str | None] = mapped_column(String, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    user_agent_hash: Mapped[str | None] = mapped_column(String, nullable=True)
```

- [ ] **Step 4: Rewrite the refresh-token model**

Replace `backend/app/models/refresh_token.py` entirely:

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RefreshToken(Base):
    """One row per token — never rotated in place.

    A rotation chain must be preserved: the grace window has to be able to look up
    a token that was consumed moments ago, and a single row can only remember one
    predecessor. Two tabs racing produce a chain, not a pair.

    revoked_at is a timestamp, not a boolean, because the grace window needs to
    know WHEN a token was consumed, not merely whether.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_user_active", "user_id", "revoked_at", "expires_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
```

Note `user_id` gains `ondelete="CASCADE"` (it had no `ondelete`), so deleting a user cleans up its
tokens — the `concurrent_sessions` fixture in Task 3 relies on being able to delete its throwaway
user.

- [ ] **Step 5: Write the migration**

`backend/alembic/versions/b5d8f0a2c4e6_add_sessions.py`:

```python
"""add sessions, make refresh tokens session-scoped

Revision ID: b5d8f0a2c4e6
Revises: a3f7c2e9d1b4
Create Date: 2026-07-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b5d8f0a2c4e6"
down_revision: str | Sequence[str] | None = "a3f7c2e9d1b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("device_name", sa.String(), nullable=True),
        sa.Column("ip_hash", sa.String(), nullable=True),
        sa.Column("user_agent_hash", sa.String(), nullable=True),
    )
    op.create_index("ix_sessions_user_live", "sessions", ["user_id", "revoked_at"])

    # The index is on (user_id, revoked, expires_at) — it must go before `revoked` does.
    op.drop_index("ix_refresh_tokens_user_active", table_name="refresh_tokens")

    # Every existing refresh token predates sessions and cannot be pointed at one:
    # no backfill, everyone signs in once more. Delete rather than revoke — a
    # revoked row with a NULL session_id could not satisfy the NOT NULL below.
    op.execute("DELETE FROM refresh_tokens")

    op.add_column(
        "refresh_tokens",
        sa.Column("session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    )
    op.add_column("refresh_tokens", sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_column("refresh_tokens", "revoked")
    op.drop_column("refresh_tokens", "device_name")
    op.drop_column("refresh_tokens", "ip_hash")
    op.drop_column("refresh_tokens", "user_agent_hash")
    op.drop_column("refresh_tokens", "last_used_at")

    # users.id FK had no ondelete; recreate it with CASCADE so deleting a user
    # cleans up its tokens (the concurrency fixture depends on this).
    op.drop_constraint("refresh_tokens_user_id_fkey", "refresh_tokens", type_="foreignkey")
    op.create_foreign_key(
        "refresh_tokens_user_id_fkey", "refresh_tokens", "users", ["user_id"], ["id"], ondelete="CASCADE"
    )

    op.create_index("ix_refresh_tokens_user_active", "refresh_tokens", ["user_id", "revoked_at", "expires_at"])


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_user_active", table_name="refresh_tokens")
    op.drop_constraint("refresh_tokens_user_id_fkey", "refresh_tokens", type_="foreignkey")
    op.create_foreign_key("refresh_tokens_user_id_fkey", "refresh_tokens", "users", ["user_id"], ["id"])
    op.execute("DELETE FROM refresh_tokens")
    op.add_column("refresh_tokens", sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("refresh_tokens", sa.Column("user_agent_hash", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("ip_hash", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("device_name", sa.String(), nullable=True))
    op.add_column("refresh_tokens", sa.Column("revoked", sa.Boolean(), nullable=False, server_default="false"))
    op.drop_column("refresh_tokens", "revoked_at")
    op.drop_column("refresh_tokens", "session_id")
    op.create_index("ix_refresh_tokens_user_active", "refresh_tokens", ["user_id", "revoked", "expires_at"])
    op.drop_index("ix_sessions_user_live", table_name="sessions")
    op.drop_table("sessions")
```

- [ ] **Step 6: Wire the model into Alembic and the test harness**

In `backend/alembic/env.py`, add to the model imports (keep alphabetical):

```python
import app.models.session  # noqa: F401
```

In `backend/tests/conftest.py`, add to the imports inside `pytest_configure` (keep alphabetical,
after `app.models.password_reset_token`):

```python
    import app.models.session  # noqa: F401
```

- [ ] **Step 7: Run the tests**

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -v`
Expected: PASS (2 tests)

Run: `cd backend && uv run pytest -q`
Expected: **FAIL** — many `test_auth.py` tests break, because `_create_session` still constructs
`RefreshToken` without `session_id` (now NOT NULL). That is expected and is Task 2's job. Do **not**
patch the router here.

- [ ] **Step 8: Verify the migration applies against a real database**

Tests never run migrations, so check it by hand:

Run: `make dev-up && make migrate`
Expected: `Running upgrade a3f7c2e9d1b4 -> b5d8f0a2c4e6`

Run: `cd backend && uv run alembic downgrade -1 && uv run alembic upgrade head`
Expected: both succeed — proves `downgrade()` is not fiction.

- [ ] **Step 9: Commit**

```bash
git add backend/app/models/session.py backend/app/models/refresh_token.py \
        backend/alembic/versions/b5d8f0a2c4e6_add_sessions.py backend/alembic/env.py \
        backend/tests/conftest.py backend/tests/test_sessions_concurrency.py
git commit -m "feat(auth): add sessions table and make refresh tokens session-scoped"
```

---

## Task 2: Sessions become the authority

**Files:**
- Create: `backend/app/services/sessions.py`
- Modify: `backend/app/auth/tokens.py:13-21`
- Modify: `backend/app/auth/dependencies.py:15-31`
- Modify: `backend/app/routers/auth.py` (`_create_session` ~`:130-144`, `refresh_tokens` ~`:381-423`)
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `UserSession`, `RefreshToken` (Task 1).
- Produces:
  - `app.services.sessions.start_session(user_id: uuid.UUID, db: AsyncSession) -> tuple[UserSession, str]`
    — creates the session + its first refresh token; returns `(session, raw_refresh_token)`.
  - `app.services.sessions.session_is_live(session_id: uuid.UUID, db: AsyncSession) -> bool`
  - `app.auth.tokens.create_access_token(user_id: uuid.UUID, email: str, session_id: uuid.UUID) -> str`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_auth.py`. It already imports `datetime`, `UTC`, `select`, `AsyncClient`
and `AsyncSession` — add only `from app.auth.tokens import decode_access_token, hash_token`
(`hash_token` is already imported) and `from app.models.session import UserSession`.

> Use the **`auth_client`** fixture (`conftest.py:115`): it registers `testuser@example.com` with
> password `testpassword123` and verifies the email, which mints a session. There is no
> `_register_and_verify` helper — do not invent one.

```python
async def test_access_token_carries_the_sid_of_a_real_session(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    session = (await db_session.execute(select(UserSession))).scalars().one()
    assert session.revoked_at is None

    payload = decode_access_token(auth_client.cookies["access_token"])
    assert payload["sid"] == str(session.id)


async def test_a_revoked_session_stops_being_accepted_immediately(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    assert (await auth_client.get(_ME_URL)).status_code == 200

    session = (await db_session.execute(select(UserSession))).scalars().one()
    session.revoked_at = datetime.now(UTC)
    await db_session.commit()

    # The access token is still perfectly valid and unexpired — the session is not.
    # This is #8's authorization half, at request level.
    assert (await auth_client.get(_ME_URL)).status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_auth.py -k "sid or revoked_session" -v`
Expected: FAIL — `KeyError: 'sid'`

- [ ] **Step 3: Write the sessions service**

Create `backend/app/services/sessions.py`:

```python
"""Session lifecycle — the only module that writes the `sessions` table.

A session is one login. It outlives the refresh tokens that rotate beneath it,
which is what makes it something you can revoke, name, and check.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_opaque_token
from app.config import settings
from app.models.refresh_token import RefreshToken
from app.models.session import UserSession
from app.models.user import User


async def start_session(user_id: uuid.UUID, db: AsyncSession) -> tuple[UserSession, str]:
    """Create a session and its first refresh token. Returns (session, raw_token)."""
    session = UserSession(user_id=user_id)
    db.add(session)
    await db.flush()
    raw = await issue_refresh_token(session, db, datetime.now(UTC))
    return session, raw


async def issue_refresh_token(session: UserSession, db: AsyncSession, now: datetime) -> str:
    """Mint a successor token inside an existing session. Returns the raw token."""
    raw, token_hash = create_opaque_token()
    db.add(
        RefreshToken(
            session_id=session.id,
            user_id=session.user_id,
            token_hash=token_hash,
            expires_at=now + timedelta(days=settings.refresh_token_expire_days),
        )
    )
    session.last_used_at = now
    await db.flush()
    return raw


async def live_session(session_id: uuid.UUID, db: AsyncSession) -> UserSession | None:
    """The session, if it exists, is not revoked, and its user is not deleted."""
    result = await db.execute(
        select(UserSession)
        .join(User, User.id == UserSession.user_id)
        .where(
            UserSession.id == session_id,
            UserSession.revoked_at.is_(None),
            User.deleted_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


async def session_is_live(session_id: uuid.UUID, db: AsyncSession) -> bool:
    return await live_session(session_id, db) is not None
```

- [ ] **Step 4: Add the `sid` claim**

In `backend/app/auth/tokens.py`, replace `create_access_token`:

```python
def create_access_token(user_id: uuid.UUID, email: str, session_id: uuid.UUID) -> str:
    expire = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {
        "sub": str(user_id),
        "email": email,
        "sid": str(session_id),
        "exp": expire,
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_ALGORITHM)
```

- [ ] **Step 5: Enforce the session per request**

In `backend/app/auth/dependencies.py`, replace `_resolve_current_user`:

```python
async def _resolve_current_user(
    access_token: str | None,
    db: AsyncSession,
) -> User:
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_access_token(access_token)
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, KeyError, ValueError):
        # A token minted before sessions existed has no `sid` and lands here (KeyError).
        # 401 is correct: its refresh token was deleted by the migration, so the client
        # refreshes, fails, and re-logs in.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from None

    # Joining sessions costs nothing extra: this lookup already ran, it just knew less.
    result = await db.execute(
        select(User)
        .join(UserSession, UserSession.user_id == User.id)
        .where(
            UserSession.id == session_id,
            UserSession.revoked_at.is_(None),
            User.id == user_id,
            User.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user
```

Add the import at the top of the file:

```python
from app.models.session import UserSession
```

- [ ] **Step 6: Point the auth router at the service**

In `backend/app/routers/auth.py`, replace `_create_session`:

```python
async def _create_session(user: User, response: Response, db: AsyncSession) -> None:
    session, raw_refresh = await start_session(user.id, db)
    csrf = generate_csrf_token()
    access = create_access_token(user.id, user.email, session.id)
    _set_auth_cookies(response, access, raw_refresh, csrf)
```

Replace the body of `refresh_tokens` from `now = datetime.now(UTC)` through
`_set_auth_cookies(...)` with a minimal session-aware rotation. **The atomic consume and the grace
window are Task 3** — this step only keeps the endpoint working now that `session_id` is NOT NULL:

```python
    now = datetime.now(UTC)
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == hash_token(refresh_token),
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    session = await live_session(record.session_id, db)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    user_result = await db.execute(select(User).where(User.id == session.user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    record.revoked_at = now
    raw_refresh = await issue_refresh_token(session, db, now)
    csrf = generate_csrf_token()
    await db.commit()

    access = create_access_token(user.id, user.email, session.id)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)
```

Update the imports at the top of `auth.py`:

```python
from app.services.sessions import issue_refresh_token, live_session, start_session
```

Then fix the remaining `create_access_token` call sites, which now need a `sid`. Both re-issue the
cookie for the **caller's own** session, so they must reuse the caller's `sid` rather than mint a
new session — a profile rename is not a login:

- `PATCH /auth/profile` (~`:476`)
- `PATCH /auth/password` (~`:503`)

Both need the caller's session id. Add a dependency that exposes it — in
`backend/app/auth/dependencies.py`:

```python
async def get_current_session_id(
    access_token: Annotated[str | None, Cookie()] = None,
) -> uuid.UUID:
    """The caller's `sid`. Assumes get_current_user already validated the token."""
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        return uuid.UUID(decode_access_token(access_token)["sid"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from None
```

and in both routes add `session_id: uuid.UUID = Depends(get_current_session_id)`, then call
`create_access_token(current_user.id, current_user.email, session_id)`.

- [ ] **Step 7: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: PASS — all of `test_auth.py` green again, plus the two new tests.

Run: `cd backend && uv run ruff check . && uv run ty check`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/sessions.py backend/app/auth/tokens.py \
        backend/app/auth/dependencies.py backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "feat(auth): make sessions the authority for access tokens"
```

---

## Task 3: Atomic rotation with a grace window (#6)

**Files:**
- Modify: `backend/app/services/sessions.py`
- Modify: `backend/app/routers/auth.py` (`refresh_tokens`)
- Modify: `backend/tests/conftest.py` (add the `concurrent_sessions` fixture)
- Test: `backend/tests/test_sessions_concurrency.py`

**Interfaces:**
- Consumes: `start_session`, `issue_refresh_token`, `live_session` (Task 2).
- Produces:
  - `app.services.sessions.RefreshRejected` — exception; the router turns it into a 401.
  - `app.services.sessions.rotate_refresh_token(raw_token: str, db: AsyncSession) -> tuple[UserSession, str]`
  - `app.services.sessions.revoke_session(session_id: uuid.UUID, db: AsyncSession) -> None`
  - pytest fixture `concurrent_sessions` → `tuple[AsyncSession, AsyncSession, uuid.UUID]`

- [ ] **Step 1: Add the concurrency fixture**

The savepoint harness **cannot express this race**: every request shares one session on one
connection, so `commit()` only releases a savepoint and two "concurrent" requests serialise. Add to
`backend/tests/conftest.py`:

```python
@pytest.fixture
async def concurrent_sessions() -> AsyncGenerator[tuple[AsyncSession, AsyncSession, uuid.UUID], None]:
    """Two independently-committing sessions plus a throwaway user.

    Everything else in this suite runs in a savepoint that is rolled back. These
    sessions really commit — which is the entire point, since the race depends on
    cross-transaction visibility — so they must clean up after themselves.

    Clean up by user, never TRUNCATE: savepoint-based tests hold open transactions
    on other connections, and a truncate would contend with them.
    """
    assert _test_engine is not None
    user_id = uuid.uuid4()

    async with AsyncSession(_test_engine, expire_on_commit=False) as setup:
        setup.add(
            User(
                id=user_id,
                email=f"race-{user_id}@example.com",
                password_hash="x",
                display_name="Race",
                email_verified_at=datetime.now(UTC),
            )
        )
        await setup.commit()

    first = AsyncSession(_test_engine, expire_on_commit=False)
    second = AsyncSession(_test_engine, expire_on_commit=False)
    try:
        yield first, second, user_id
    finally:
        await first.close()
        await second.close()
        async with AsyncSession(_test_engine, expire_on_commit=False) as cleanup:
            # refresh_tokens and sessions both cascade from users.
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
```

Add the imports `backend/tests/conftest.py` needs:

```python
import uuid
from datetime import UTC, datetime

from sqlalchemy import delete

from app.models.user import User
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/tests/test_sessions_concurrency.py`:

```python
import asyncio

from app.services.sessions import (
    RefreshRejected,
    revoke_session,
    rotate_refresh_token,
    start_session,
)


async def test_two_tabs_racing_refresh_both_succeed_in_one_session(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Tabs share one access-token cookie, so they expire together and refresh together.
    This race is the normal case, not an edge case: both must survive it."""
    first, second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.commit()
    session_id = session.id

    results = await asyncio.gather(
        rotate_refresh_token(raw, first),
        rotate_refresh_token(raw, second),
        return_exceptions=True,
    )
    await first.commit()
    await second.commit()

    assert not any(isinstance(r, Exception) for r in results), results
    assert {r[0].id for r in results} == {session_id}

    live = (
        await first.execute(
            select(UserSession).where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        )
    ).scalar_one_or_none()
    assert live is not None, "the stampede must not be mistaken for theft"


async def test_replay_after_the_grace_window_revokes_the_session(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    first, _second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.commit()

    await rotate_refresh_token(raw, first)
    await first.commit()

    # Backdate the consume past the window rather than sleeping 10s in a test.
    await first.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == hash_token(raw))
        .values(revoked_at=datetime.now(UTC) - timedelta(seconds=30))
    )
    await first.commit()

    with pytest.raises(RefreshRejected):
        await rotate_refresh_token(raw, first)
    await first.commit()

    revoked = (
        await first.execute(select(UserSession).where(UserSession.id == session.id))
    ).scalar_one()
    assert revoked.revoked_at is not None


async def test_an_expired_token_is_expiry_not_theft(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    """Someone who closed their laptop for a week must not have their session
    revoked for it — expiry and replay look alike and must not be confused."""
    first, _second, user_id = concurrent_sessions

    session, raw = await start_session(user_id, first)
    await first.execute(
        update(RefreshToken)
        .where(RefreshToken.token_hash == hash_token(raw))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    await first.commit()

    with pytest.raises(RefreshRejected):
        await rotate_refresh_token(raw, first)
    await first.commit()

    session_row = (
        await first.execute(select(UserSession).where(UserSession.id == session.id))
    ).scalar_one()
    assert session_row.revoked_at is None, "ordinary expiry must not revoke the session"
```

Add to that file's imports (`pytest` arrives here, for `pytest.raises`):

```python
import asyncio

import pytest
from sqlalchemy import update

from app.auth.tokens import hash_token
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -v`
Expected: FAIL — `ImportError: cannot import name 'RefreshRejected'`

- [ ] **Step 4: Implement atomic rotation**

Add to `backend/app/services/sessions.py`:

```python
_GRACE_WINDOW = timedelta(seconds=10)


class RefreshRejected(Exception):
    """The refresh token cannot be rotated. The router turns this into a 401."""


async def revoke_session(session_id: uuid.UUID, db: AsyncSession) -> None:
    """Kill a session. The only way a session dies — every trigger routes here.

    Individual tokens are left alone: every path that consumes one joins `sessions`
    and rejects a revoked one, so the session flag alone is sufficient.
    """
    await db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )


async def rotate_refresh_token(raw_token: str, db: AsyncSession) -> tuple[UserSession, str]:
    """Consume a refresh token and mint its successor.

    The database picks the winner, not the application: an application-level
    read-then-write lets two concurrent requests both observe a valid token and
    both mint a successor, which is exactly finding #6.
    """
    now = datetime.now(UTC)
    token_hash = hash_token(raw_token)

    consumed = await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
        .values(revoked_at=now)
        .returning(RefreshToken.session_id)
    )
    winning_session_id = consumed.scalar_one_or_none()

    if winning_session_id is not None:
        session = await live_session(winning_session_id, db)
        if session is None:
            raise RefreshRejected
        return session, await issue_refresh_token(session, db, now)

    # We lost, or the token was never usable. Work out which — the order below is
    # load-bearing.
    existing = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    token = existing.scalar_one_or_none()
    if token is None:
        raise RefreshRejected

    # Expiry BEFORE reuse: an expired-and-previously-rotated token matches both, and
    # it must read as expiry. Revoking the session of someone who was away for a week
    # would be noise, not security.
    if token.expires_at <= now:
        raise RefreshRejected

    session = await live_session(token.session_id, db)
    if session is None:
        raise RefreshRejected

    if token.revoked_at is None:
        # Not expired, not revoked, yet the UPDATE matched nothing. Should be
        # unreachable; refuse rather than guess.
        raise RefreshRejected

    if now - token.revoked_at <= _GRACE_WINDOW:
        # The tab stampede. Each racing tab gets its OWN successor (we store hashes
        # and cannot reissue the same raw token); both are valid, both belong to this
        # session, and the cookie jar keeps whichever lands last.
        return session, await issue_refresh_token(session, db, now)

    # Held and replayed long after it was spent: the theft shape.
    await revoke_session(token.session_id, db)
    raise RefreshRejected
```

Add `update` to the SQLAlchemy import and `hash_token` to the tokens import at the top of the file:

```python
from sqlalchemy import select, update
from app.auth.tokens import create_opaque_token, hash_token
```

- [ ] **Step 5: Use it from the router**

In `backend/app/routers/auth.py`, replace the body of `refresh_tokens` after the
`if not refresh_token:` guard:

```python
    try:
        session, raw_refresh = await rotate_refresh_token(refresh_token, db)
    except RefreshRejected:
        await db.commit()  # a reuse-triggered revocation must persist
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token"
        ) from None

    user_result = await db.execute(select(User).where(User.id == session.user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        await db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    csrf = generate_csrf_token()
    await db.commit()

    access = create_access_token(user.id, user.email, session.id)
    _set_auth_cookies(response, access, raw_refresh, csrf)
    return UserResponse.model_validate(user)
```

Update the import:

```python
from app.services.sessions import (
    RefreshRejected,
    issue_refresh_token,
    live_session,
    rotate_refresh_token,
    start_session,
)
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -v`
Expected: PASS (5 tests)

Run: `cd backend && uv run pytest -q`
Expected: PASS — `test_refresh_rotates_token` still green.

- [ ] **Step 7: Prove the race test can actually fail**

A concurrency test that passes against broken code is worse than no test. Temporarily revert the
atomic consume to the read-then-write it replaced:

```python
    # TEMPORARY — must make the stampede test fail
    found = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > now,
        )
    )
    token = found.scalar_one_or_none()
    winning_session_id = token.session_id if token else None
    if token:
        token.revoked_at = now
```

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -v`
Expected: the suite must **not** be fully green. Restore the atomic version and re-run — green.

If it stays green either way, the fixture is not producing real concurrency (most likely both
sessions share a connection, or a `commit()` is missing) — stop and fix the fixture, because
everything else in this task rests on it.

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/sessions.py backend/app/routers/auth.py \
        backend/tests/conftest.py backend/tests/test_sessions_concurrency.py
git commit -m "feat(auth): consume refresh tokens atomically with a reuse grace window"
```

---

## Task 4: Atomic password-reset consume (#6, second half)

**Files:**
- Create: `backend/app/services/password_reset.py`
- Modify: `backend/app/routers/auth.py` (`confirm_password_reset` ~`:322-357`)
- Test: `backend/tests/test_sessions_concurrency.py`

**Interfaces:**
- Consumes: `concurrent_sessions` fixture (Task 3).
- Produces: `app.services.password_reset.consume_password_reset_token(raw_token: str, db: AsyncSession) -> uuid.UUID | None`
  — atomically spends the token; returns its `user_id`, or `None` if it could not be spent.

> **Why a service module rather than inline SQL in the route:** this race can only be driven below
> HTTP — the `concurrent_sessions` fixture has no app client, and the route needs a live email flow
> to reach. So the consume must be callable directly. A test that re-declared the `UPDATE` inline
> would assert its own SQL and pin nothing about the route.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_sessions_concurrency.py`:

```python
async def test_two_concurrent_reset_confirms_consume_the_token_once(
    concurrent_sessions: tuple[AsyncSession, AsyncSession, uuid.UUID],
) -> None:
    from app.auth.tokens import create_opaque_token
    from app.models.password_reset_token import PasswordResetToken
    from app.services.password_reset import consume_password_reset_token

    first, second, user_id = concurrent_sessions
    raw, token_hash = create_opaque_token()
    first.add(
        PasswordResetToken(
            user_id=user_id,
            token_hash=token_hash,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    await first.commit()

    async def consume(db: AsyncSession) -> uuid.UUID | None:
        won = await consume_password_reset_token(raw, db)
        await db.commit()
        return won

    outcomes = await asyncio.gather(consume(first), consume(second))
    assert sum(o is not None for o in outcomes) == 1, "exactly one confirm may win"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_sessions_concurrency.py -k reset_confirms -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.password_reset'`

- [ ] **Step 3: Write the service**

Create `backend/app/services/password_reset.py`:

```python
"""Password-reset token consumption.

Separate from the router so the race can be driven directly: it happens below
HTTP, and the route needs a live email flow to reach.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_token
from app.models.password_reset_token import PasswordResetToken


async def consume_password_reset_token(raw_token: str, db: AsyncSession) -> uuid.UUID | None:
    """Atomically spend a reset token. Returns its user_id, or None if unusable.

    The database picks the winner. The read-then-write this replaces let two
    concurrent confirms both observe an unused token and both reset the password —
    and the window was wide, because an Argon2 hash (~50-100ms) sat between the
    read and the commit.
    """
    now = datetime.now(UTC)
    result = await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.token_hash == hash_token(raw_token),
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > now,
        )
        .values(used_at=now)
        .returning(PasswordResetToken.user_id)
    )
    return result.scalar_one_or_none()
```

- [ ] **Step 4: Make the route use it**

In `backend/app/routers/auth.py`, replace the lookup in `confirm_password_reset` — everything from
`now = datetime.now(UTC)` down to and including `token.used_at = now`:

```python
    token_user_id = await consume_password_reset_token(body.token, db)
    if token_user_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    user_result = await db.execute(select(User).where(User.id == token_user_id, User.deleted_at.is_(None)))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset link")

    user.password_hash = hash_password(body.new_password)
```

Add the import:

```python
from app.services.password_reset import consume_password_reset_token
```

This also lifts the Argon2 hash out from between the read and the commit — the thing that made the
window wide enough to hit in the first place.

Leave the refresh-token revocation that follows for Task 5 — it becomes a session revocation there.

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest tests/test_auth.py tests/test_sessions_concurrency.py -q`
Expected: PASS — the existing reset tests (valid, expired, replay) stay green.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/password_reset.py backend/app/routers/auth.py \
        backend/tests/test_sessions_concurrency.py
git commit -m "fix(auth): consume password-reset tokens atomically"
```

---

## Task 5: Per-session revocation (#7)

**Files:**
- Modify: `backend/app/services/sessions.py`
- Modify: `backend/app/routers/auth.py` (`logout` ~`:427-441`, `confirm_password_reset`, `change_password` ~`:480-503`)
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `revoke_session` (Task 3).
- Produces: `app.services.sessions.revoke_user_sessions(user_id: uuid.UUID, db: AsyncSession, *, except_session_id: uuid.UUID | None = None) -> None`

- [ ] **Step 1: Write the failing test**

These tests need a **second session for the same user**. `register_client` in `tests/helpers.py`
creates a *different* account, so it does not fit — log in again on a second client instead. Add this
helper to `backend/tests/test_auth.py`:

```python
async def _second_device(email: str = "testuser@example.com", password: str = "testpassword123") -> AsyncClient:
    """A second live session for the SAME user — auth_client's own credentials.

    tests.helpers.register_client makes a different ACCOUNT, which is not the same
    thing: revocation is per session, so the test needs one user with two.
    """
    device = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await device.__aenter__()
    resp = await device.post(_LOGIN_URL, json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return device
```

and add `ASGITransport` to the existing httpx import: `from httpx import ASGITransport, AsyncClient`.

Then the tests:

```python
async def test_password_change_revokes_other_sessions_but_not_the_callers(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The containment users expect from a password change — without signing them
    out of the tab they are standing in."""
    other = await _second_device()
    assert (await other.get(_ME_URL)).status_code == 200

    set_csrf(auth_client)
    resp = await auth_client.patch(
        _PASSWORD_URL,
        json={"current_password": "testpassword123", "new_password": "newpassword456"},
    )
    assert resp.status_code == 204, resp.text

    assert (await auth_client.get(_ME_URL)).status_code == 200, "caller keeps their session"
    assert (await other.get(_ME_URL)).status_code == 401, "other devices are signed out"
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sum(s.revoked_at is None for s in sessions) == 1


async def test_logout_revokes_only_the_current_session(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    other = await _second_device()

    set_csrf(auth_client)
    resp = await auth_client.post(_LOGOUT_URL)
    assert resp.status_code == 204

    assert (await other.get(_ME_URL)).status_code == 200, "other devices are untouched"
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert sum(s.revoked_at is None for s in sessions) == 1


async def test_password_reset_revokes_every_session(
    auth_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The reset flow is unauthenticated — there is no caller session to spare, so
    unlike a password change this revokes everything."""
    other = await _second_device()

    await auth_client.post(_PASSWORD_RESET_REQUEST_URL, json={"email": "testuser@example.com"})
    token = app.state.password_reset_tokens["testuser@example.com"]
    resp = await auth_client.post(
        _PASSWORD_RESET_CONFIRM_URL, json={"token": token, "new_password": "resetpassword789"}
    )
    assert resp.status_code == 204, resp.text

    assert (await other.get(_ME_URL)).status_code == 401
    await other.aclose()

    sessions = (await db_session.execute(select(UserSession))).scalars().all()
    assert all(s.revoked_at is not None for s in sessions)
```

`set_csrf` (from `tests.helpers`, already imported by `test_auth.py`) sets both halves of the
double-submit pair, which is how the other CSRF-guarded tests in this file authenticate.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_auth.py -k "revokes_other_sessions or logout_revokes_only" -v`
Expected: FAIL — the password-change test fails on `other` still returning 200.

- [ ] **Step 3: Add the fan-out revoke**

Add to `backend/app/services/sessions.py`:

```python
async def revoke_user_sessions(
    user_id: uuid.UUID,
    db: AsyncSession,
    *,
    except_session_id: uuid.UUID | None = None,
) -> None:
    """Revoke every live session for a user, optionally sparing one.

    `except_session_id` is what lets a password change sign out your other devices
    without signing out the tab you changed it in.
    """
    query = update(UserSession).where(
        UserSession.user_id == user_id,
        UserSession.revoked_at.is_(None),
    )
    if except_session_id is not None:
        query = query.where(UserSession.id != except_session_id)
    await db.execute(query.values(revoked_at=datetime.now(UTC)))
```

- [ ] **Step 4: Route every trigger through it**

In `backend/app/routers/auth.py`:

**`logout`** — revoke the session, not the token:

```python
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    _csrf: None = Depends(require_csrf),
    refresh_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Revoke the current session and clear auth cookies."""
    if refresh_token:
        result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(refresh_token)))
        record = result.scalar_one_or_none()
        if record:
            await revoke_session(record.session_id, db)
            await db.commit()
    _clear_auth_cookies(response)
```

**`confirm_password_reset`** — replace the bulk `update(RefreshToken)…values(revoked=True)` with:

```python
    await revoke_user_sessions(user.id, db)
```

(no `except_session_id`: the reset flow is unauthenticated, so there is no caller session to spare.)

**`change_password`** — add the session-id dependency and revoke the rest, immediately before
`await db.commit()`:

```python
    await revoke_user_sessions(current_user.id, db, except_session_id=session_id)
```

Its signature already gained `session_id: uuid.UUID = Depends(get_current_session_id)` in Task 2.

Update the import:

```python
from app.services.sessions import (
    RefreshRejected,
    issue_refresh_token,
    live_session,
    revoke_session,
    revoke_user_sessions,
    rotate_refresh_token,
    start_session,
)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: PASS — including the existing `test_refresh_after_logout_returns_401`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/sessions.py backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "feat(auth): revoke sessions on password change and logout"
```

---

## Task 6: `/auth/refresh` CSRF and rate limit (#44)

**Files:**
- Modify: `backend/app/routers/auth.py` (`refresh_tokens`)
- Test: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

> `/auth/refresh` is the only unauthenticated POST in this router with neither guard, while
> `logout`, `profile`, `password` and `preferences` all have both. `backend/CLAUDE.md`: **every
> non-GET route must add the CSRF dependency.**
>
> **`require_csrf` cannot be used here.** It depends on `get_current_user`, and the whole point of
> `/refresh` is that the access token has expired — so the standard dependency would 401 every
> legitimate refresh. Compare the two cookies directly instead.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_auth.py`:

```python
async def test_refresh_requires_csrf(auth_client: AsyncClient) -> None:
    csrf = auth_client.cookies.get("csrf_token")
    assert csrf is not None

    assert (await auth_client.post(_REFRESH_URL)).status_code == 403
    assert (
        await auth_client.post(_REFRESH_URL, headers={"X-CSRF-Token": "wrong"})
    ).status_code == 403
    assert (
        await auth_client.post(_REFRESH_URL, headers={"X-CSRF-Token": csrf})
    ).status_code == 200
```

> **The rate limit is deliberately not tested.** No route's rate limit is tested anywhere in this
> suite (grep: zero occurrences of `429`), so there is no established pattern to follow, and whether
> `get_remote_address` buckets correctly under httpx's `ASGITransport` — where `request.client` may
> be `None` — is unverified. Inventing that here would put an unproven harness question inside a
> security task. If it matters later, it is its own piece of work. The CSRF half, which is the part
> `backend/CLAUDE.md` actually mandates, is covered above.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_auth.py -k refresh_requires_csrf -v`
Expected: FAIL — `assert 200 == 403` on the first call.

- [ ] **Step 3: Add a CSRF check that does not require a live access token**

In `backend/app/auth/dependencies.py`:

```python
async def require_csrf_without_session(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie()] = None,
) -> None:
    """Double-submit CSRF check with no access-token requirement.

    /auth/refresh exists precisely because the access token has expired, so it
    cannot depend on get_current_user the way require_csrf does.
    """
    if not csrf_token or not x_csrf_token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing")
    if not secrets.compare_digest(csrf_token, x_csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token invalid")
```

Refactor `require_csrf` to delegate, so the comparison lives in one place:

```python
async def require_csrf(
    x_csrf_token: Annotated[str | None, Header()] = None,
    csrf_token: Annotated[str | None, Cookie()] = None,
    _user: User = Depends(get_current_user),
) -> None:
    await require_csrf_without_session(x_csrf_token, csrf_token)
```

- [ ] **Step 4: Apply both guards to the route**

In `backend/app/routers/auth.py`, change the `refresh_tokens` decorator and signature:

```python
@router.post("/refresh", response_model=UserResponse)
@limiter.limit("30/minute")
async def refresh_tokens(
    request: Request,
    response: Response,
    _csrf: None = Depends(require_csrf_without_session),
    refresh_token: Annotated[str | None, Cookie()] = None,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
```

`slowapi` requires the `request: Request` parameter to be present for `@limiter.limit` to work —
match how the other rate-limited routes in this file declare it. Update the import:

```python
from app.auth.dependencies import get_current_session_id, get_current_user, require_csrf, require_csrf_without_session
```

The limit is 30/minute: a legitimate multi-tab stampede is a handful of requests within a second,
so this must not be as tight as login's.

- [ ] **Step 5: Run the tests**

The existing `test_refresh` (`tests/test_auth.py:241`) and `test_refresh_rotates_token` (`:248`) will
now 403. They assert rotation, not CSRF — give them the header rather than weakening them:

```python
async def test_refresh(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    resp = await auth_client.post(_REFRESH_URL)
    assert resp.status_code == 200
    assert "access_token" in resp.cookies
    assert "csrf_token" in resp.cookies


async def test_refresh_rotates_token(auth_client: AsyncClient) -> None:
    set_csrf(auth_client)
    old_refresh = auth_client.cookies.get("refresh_token")
    await auth_client.post(_REFRESH_URL)
    new_refresh = auth_client.cookies.get("refresh_token")
    assert old_refresh != new_refresh
```

Note `set_csrf` overwrites the `csrf_token` cookie with a fixed value and sets the matching header,
so the double-submit pair still agrees — that is the pattern the rest of the file uses.

Run: `cd backend && uv run pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/auth/dependencies.py backend/app/routers/auth.py backend/tests/test_auth.py
git commit -m "fix(auth): require CSRF and rate-limit the refresh endpoint"
```

---

## Task 7: SSE streams stop when their session dies (#8 authz half)

**Files:**
- Modify: `backend/app/sse/manager.py`
- Modify: `backend/app/routers/sse.py`
- Modify: `backend/app/services/sessions.py`
- Test: `backend/tests/test_sse.py`

**Interfaces:**
- Consumes: `session_is_live` (Task 2), `revoke_session` / `revoke_user_sessions` (Tasks 3, 5).
- Produces:
  - `app.sse.manager.REVOKED_SENTINEL`
  - `SseManager.disconnect_session(session_id: uuid.UUID) -> None`
  - `_Client.session_id: uuid.UUID`
  - `stream_events(client, *, send_resync: bool, revalidate: Callable[[uuid.UUID], Awaitable[bool]])`

> **The guarantee is the deadline check; the in-process drop is only a latency optimisation.** Build
> it in that order. Reverse them and the drop's dependencies (single worker, choke-point discipline)
> silently become correctness dependencies.
>
> **The existing 5s `wait_for` is an idle timeout, not a heartbeat.** It fires only when the queue is
> empty, so a check hung off the `TimeoutError` branch would never run for a client receiving a
> steady trickle of events — the busiest clients, which matter most. Compare the deadline on **both**
> branches.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_sse.py`:

```python
@pytest.mark.asyncio
async def test_stream_ends_when_revalidation_fails() -> None:
    """The guarantee: a revoked session stops streaming, with no help from the manager."""
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())

    frames = []
    gen = stream_events(client, send_resync=False, revalidate=_never_live)
    with anyio.move_on_after(2):
        async for frame in gen:
            frames.append(frame)

    assert frames == [connected_dict()], "no resync frame — the client must re-auth, not refetch"


@pytest.mark.asyncio
async def test_revalidation_deadline_fires_on_a_busy_stream() -> None:
    """The idle-timeout trap: a stream receiving a steady trickle of events must
    still revalidate. A check hung off the TimeoutError branch would never run here."""
    from app.routers.sse import stream_events

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    for _ in range(50):
        client.queue.put_nowait({"event": "noise", "data": "{}"})

    calls = 0

    async def revalidate(_session_id: uuid.UUID) -> bool:
        nonlocal calls
        calls += 1
        return calls < 2  # live once, then revoked

    frames = []
    with anyio.move_on_after(2):
        async for frame in stream_events(client, send_resync=False, revalidate=revalidate):
            frames.append(frame)

    assert calls >= 2, "the deadline never fired while the queue was busy"
    assert len(frames) < 51, "the stream must end, not drain the whole queue"


@pytest.mark.asyncio
async def test_revoked_sentinel_ends_the_stream_without_a_resync() -> None:
    from app.routers.sse import stream_events
    from app.sse.manager import REVOKED_SENTINEL

    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    client.queue.put_nowait(REVOKED_SENTINEL)

    frames = []
    with anyio.move_on_after(2):
        async for frame in stream_events(client, send_resync=False, revalidate=_always_live):
            frames.append(frame)

    assert frames == [connected_dict()]


@pytest.mark.asyncio
async def test_disconnect_session_only_drops_that_session() -> None:
    mgr = SseManager()
    session_a, session_b = uuid.uuid4(), uuid.uuid4()
    user = uuid.uuid4()
    a = mgr.connect(user, session_id=session_a)
    b = mgr.connect(user, session_id=session_b)

    mgr.disconnect_session(session_a)

    assert a.queue.get_nowait() is REVOKED_SENTINEL
    assert b.queue.empty(), "the user's other devices are untouched"


@pytest.mark.asyncio
async def test_eviction_still_resyncs() -> None:
    """No regression to 44a9e15: falling behind is not the same as being revoked."""
    mgr = SseManager()
    client = mgr.connect(uuid.uuid4(), session_id=uuid.uuid4())
    for _ in range(_QUEUE_MAX + 5):
        await mgr.broadcast({"event": "x", "data": "{}"}, actor_id=client.user_id)

    assert client.queue.get_nowait() is CLOSED_SENTINEL
```

Add these helpers near the top of `test_sse.py`:

```python
async def _always_live(_session_id: uuid.UUID) -> bool:
    return True


async def _never_live(_session_id: uuid.UUID) -> bool:
    return False
```

and the imports `import anyio`, `from app.sse.events import connected_dict`,
`from app.sse.manager import CLOSED_SENTINEL, REVOKED_SENTINEL, SseManager, _QUEUE_MAX`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_sse.py -v`
Expected: FAIL — `TypeError: connect() got an unexpected keyword argument 'session_id'`

- [ ] **Step 3: Teach the manager about sessions**

In `backend/app/sse/manager.py`:

```python
# Pushed onto a client's queue when its session is revoked. Distinct from
# CLOSED_SENTINEL: that means "you fell behind, resync", which is wrong here — a
# revoked client that resynced would fire a burst of GETs that all 401 and end at
# /login anyway. This ends the stream with no resync frame, so the client
# reconnects, 401s, fails to refresh, and goes to /login directly.
REVOKED_SENTINEL = object()


@dataclass
class _Client:
    user_id: uuid.UUID
    session_id: uuid.UUID
    manager: "SseManager"
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_QUEUE_MAX))
```

```python
    def connect(self, user_id: uuid.UUID, *, session_id: uuid.UUID) -> _Client:
        """Register a new SSE connection and return its client handle."""
        client = _Client(user_id=user_id, session_id=session_id, manager=self)
        self._clients.append(client)
        return client

    def disconnect_session(self, session_id: uuid.UUID) -> None:
        """Drop every stream belonging to a revoked session.

        A latency optimisation, NOT the guarantee: stream_events revalidates on a
        deadline regardless, so a missed call here costs up to 30s of staleness
        rather than correctness. That ordering is deliberate — it keeps this
        method's single-worker assumption out of the security argument.
        """
        for client in list(self._clients):
            if client.session_id != session_id:
                continue
            with contextlib.suppress(asyncio.QueueFull):
                client.queue.put_nowait(REVOKED_SENTINEL)
            self.disconnect(client)
```

- [ ] **Step 4: Add the deadline check to the stream**

Replace `stream_events` in `backend/app/routers/sse.py`:

```python
_REVALIDATE_EVERY = timedelta(seconds=30)


async def stream_events(
    client: _Client,
    *,
    send_resync: bool,
    revalidate: Callable[[uuid.UUID], Awaitable[bool]],
) -> AsyncGenerator[dict, None]:
    """Yield SSE frames for one connection until it closes, is evicted, or its
    session is revoked.

    Module-level (rather than nested in the route) so tests can drive it directly:
    httpx's ASGI transport cannot cleanly close an infinite SSE generator.

    `revalidate` is injected rather than reached for. Tests override get_db to yield
    a savepoint-bound session; a revalidation that opened its own session from
    async_session_factory would bypass that override, query outside the test's
    savepoint, fail to see the session row the test just created, conclude
    "revoked", and kill the stream — every SSE test failing for a reason that looks
    nothing like the cause.
    """
    next_check = datetime.now(UTC) + _REVALIDATE_EVERY
    try:
        yield connected_dict()

        if send_resync:
            yield resync_dict()

        while True:
            # Checked on BOTH branches below, before anything else. The 5s wait_for
            # is an idle timeout, not a heartbeat: a busy client never times out, so
            # a check hung off TimeoutError would never run for the clients that
            # matter most.
            if datetime.now(UTC) >= next_check:
                if not await revalidate(client.session_id):
                    return
                next_check = datetime.now(UTC) + _REVALIDATE_EVERY

            try:
                msg = await asyncio.wait_for(client.queue.get(), timeout=5.0)
            except TimeoutError:
                # No event in the last 5s — loop. sse-starlette's ping=25 sends
                # keepalive comments independently.
                continue

            if msg is CLOSED_SENTINEL:
                # Evicted for falling behind: tell the client to resync and end the
                # response. EventSource reconnects and re-syncs from Last-Event-ID.
                yield resync_dict()
                return

            if msg is REVOKED_SENTINEL:
                # Session revoked. End with no resync — the client must re-auth.
                return

            yield msg
    finally:
        client.manager.disconnect(client)
```

Update the route to supply the real revalidation and the session id:

```python
async def _revalidate_session(session_id: uuid.UUID) -> bool:
    """Open a short-lived session per check: the request's DB session must not be
    pinned for the stream's lifetime (which is why get_current_user_for_stream uses
    scope="function")."""
    async with async_session_factory() as db:
        return await session_is_live(session_id, db)


@router.get("")
async def sse_stream(
    request: Request,
    current_user: User = Depends(get_current_user_for_stream),
    session_id: uuid.UUID = Depends(get_current_session_id),
) -> EventSourceResponse:
    """Open an SSE stream for the authenticated user."""
    send_resync = _should_resync_on_connect(request.headers.get("last-event-id"))
    client = manager.connect(current_user.id, session_id=session_id)
    return EventSourceResponse(
        stream_events(client, send_resync=send_resync, revalidate=_revalidate_session),
        ping=25,
    )
```

Imports for `backend/app/routers/sse.py`:

```python
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable
from datetime import UTC, datetime, timedelta

from app.auth.dependencies import get_current_session_id, get_current_user_for_stream
from app.database import async_session_factory
from app.services.sessions import session_is_live
from app.sse.manager import CLOSED_SENTINEL, REVOKED_SENTINEL, _Client, manager
```

- [ ] **Step 5: Drop streams from the revoke choke point**

In `backend/app/services/sessions.py`, make both revoke functions drop live streams. Import inside
the functions to avoid a circular import (`app.sse.manager` does not import services, and this keeps
it that way):

```python
async def revoke_session(session_id: uuid.UUID, db: AsyncSession) -> None:
    await db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    _drop_streams(session_id)


def _drop_streams(session_id: uuid.UUID) -> None:
    """Latency optimisation only — stream_events revalidates on a deadline anyway."""
    from app.sse.manager import manager

    manager.disconnect_session(session_id)
```

In `revoke_user_sessions`, collect the ids first so the same drop can happen:

```python
async def revoke_user_sessions(
    user_id: uuid.UUID,
    db: AsyncSession,
    *,
    except_session_id: uuid.UUID | None = None,
) -> None:
    query = update(UserSession).where(
        UserSession.user_id == user_id,
        UserSession.revoked_at.is_(None),
    )
    if except_session_id is not None:
        query = query.where(UserSession.id != except_session_id)
    result = await db.execute(query.values(revoked_at=datetime.now(UTC)).returning(UserSession.id))
    for revoked_id in result.scalars().all():
        _drop_streams(revoked_id)
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && uv run pytest tests/test_sse.py -v`
Expected: PASS

Run: `cd backend && uv run pytest -q && uv run ruff check . && uv run ty check`
Expected: PASS, clean.

- [ ] **Step 7: Prove the deadline test would catch the idle-timeout trap**

Move the deadline check inside the `except TimeoutError:` branch (where it would be natural to put
it, and where it would be wrong):

```python
            except TimeoutError:
                if datetime.now(UTC) >= next_check:
                    if not await revalidate(client.session_id):
                        return
                    next_check = datetime.now(UTC) + _REVALIDATE_EVERY
                continue
```

Run: `cd backend && uv run pytest tests/test_sse.py -k busy_stream -v`
Expected: **FAIL** — the busy stream never revalidates. Restore the correct version and re-run.

- [ ] **Step 8: Commit**

```bash
git add backend/app/sse/manager.py backend/app/routers/sse.py \
        backend/app/services/sessions.py backend/tests/test_sse.py
git commit -m "feat(sse): end streams whose session has been revoked"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/references/review-findings.md`
- Modify: `CONTEXT.md`
- Modify: `docs/shipped/session-revocation-design.md` (status)
- Move: `docs/shipped/session-revocation-{design,plan}.md` → `docs/shipped/`

> **Run this task LAST — it needs the real commit SHAs from Tasks 1-7.**

- [ ] **Step 1: Collect the SHAs**

Run: `git log --oneline a3f7c2e9d1b4..HEAD` — or `git log --oneline -8` — and note the SHA of each
task's commit.

- [ ] **Step 2: Update the dispositions**

In `docs/references/review-findings.md`, add a **Disposition** line to #6 and #7, and **rewrite**
#8's (it is currently ◐ Partially done for the eviction half):

- **#6** — ✅ Done (SHAs from Tasks 3, 4). Refresh and reset consume atomically via
  `UPDATE … RETURNING`; refresh gained a session/family with reuse detection outside a 10s grace
  window. Note that the grace window is not a nicety: tabs share one access-token cookie and expire
  together, so an atomic consume without it converts today's silent double-mint into visible
  logouts.
- **#7** — ✅ Done (SHA from Task 5). Password change revokes all sessions except the caller's;
  reset revokes all; logout revokes one. Access authentication checks the session per request, so
  revocation is immediate rather than bounded by the 15-minute JWT. Device-list UI deliberately not
  built — the `sessions` row makes it cheap later.
- **#8** — ✅ Done (SHAs from `44a9e15` + Tasks 1, 2, 7). Both halves now closed. State the claim in
  checkable terms rather than compliance terms:
  > A revoked session stops streaming within 30 seconds, and stops being accepted on requests
  > immediately.

  **Record the supersession explicitly:** #8's proposal ("end connections at token expiry and require
  reauthentication") was written when the JWT was the only authority. This work moved the authority
  to the session, at which point bounding the JWT became a *proxy* for bounding authorization — and
  a poor one (a session revoked a minute after a refresh would stream on for fourteen more), while
  costing a full resync across every tab every 15 minutes. Replaced by per-iteration session
  revalidation, which is more work and a stronger guarantee.
- **#44** — ✅ Done (SHA from Task 6). CSRF + 30/minute rate limit. Note `require_csrf` could not be
  reused (it depends on `get_current_user`, and `/refresh` exists because the access token expired);
  `require_csrf_without_session` compares the cookies directly.

- [ ] **Step 3: Add the changelog entry**

Add to the **Changelog** in `docs/references/review-findings.md`:

Use the **actual date this ships** (`date +%F`), not the date on the spec — the changelog records
when work landed, and this plan was written before it did.

```markdown
- **<ship date>** — Phase 2 spec 1 (session revocation) shipped (SHAs): #6, #7 and #8 all closed.
  The app now has sessions — one row per login, stable across rotation — so credentials can be
  revoked per device, reuse detected, and streams ended when authority is withdrawn. Existing
  sessions were revoked by the migration: everyone signed in once more. Phase 2 remainder: #1,
  #13 (+ #43), #31.
```

Update the Phase 2 spec table: spec 1 → ✅ Shipped.

- [ ] **Step 4: Update CONTEXT.md**

In the **Auth & account** section, replace the session bullet so it describes what is now true:

```markdown
- Sessions are first-class: one `sessions` row per login, stable across refresh rotation. The access
  JWT carries its `sid` and every request checks the session is live, so revocation is immediate.
  Password change revokes every other session and keeps yours; reset revokes all; logout revokes
  one. Refresh rotation consumes atomically, with a 10s grace window so racing tabs (which share one
  cookie and expire together) both survive — a replay after that window is treated as theft and
  revokes the session.
```

In the **Real-time (SSE)** section, replace the "**Streams are still authenticated only at
connect**" bullet (it is no longer true):

```markdown
- Streams revalidate their session every 30s and end when it is revoked; revocation also drops them
  in-process immediately. The in-process drop is a latency optimisation, not the guarantee — the
  periodic check is worker-agnostic and holds without it.
```

In **In flight**, update the Phase 2 line to name what remains: #1, #13 (+ #43), #31.

- [ ] **Step 5: Move the spec and plan to shipped**

```bash
git mv docs/shipped/session-revocation-design.md docs/shipped/session-revocation-design.md
git mv docs/shipped/session-revocation-plan.md docs/shipped/session-revocation-plan.md
```

Flip both `Status:` lines to `✅ Shipped 2026-07-16 (<SHAs>)`. Add a **"Deviations from this design
(as shipped)"** section to the design doc if the implementation diverged — and grep for stale
`docs/designs/session-revocation` references afterwards:

```bash
grep -rn "designs/session-revocation" --include=*.md . | grep -v node_modules
```

- [ ] **Step 6: Commit**

```bash
git add docs/ CONTEXT.md
git commit -m "docs(auth): record session revocation shipment, close #6/#7/#8"
```

---

## Notes for the implementer

- **The one test that must not be trusted on a green run** is the stampede test in Task 3. Its whole
  value is that it fails against a read-then-write consume — Step 7 of that task exists to prove it
  does. A concurrency test that passes against broken code is worse than none.
- **`make test` needs Docker.** Backend pytest uses Testcontainers.
- **Do not add `docker compose down -v` to any workflow** — it wipes the database volume.
- **Confirm with the maintainer before committing and before pushing.** Every time.
