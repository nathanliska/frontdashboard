import uuid
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.models.dashboard import Dashboard
from app.models.user import User

CSRF = "test-csrf-token"


def set_csrf(client: AsyncClient) -> None:
    client.cookies.set("csrf_token", CSRF)
    client.headers.update({"x-csrf-token": CSRF})


async def register_user(
    client: AsyncClient,
    email: str,
    *,
    display_name: str = "Member",
    password: str = "test-password-123",
) -> dict:
    """Register + verify on an *existing* client (register_client below spins up a new one)."""
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "display_name": display_name},
    )
    assert resp.status_code == 201, resp.text
    token = app.state.email_verification_tokens[email]
    verify_resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert verify_resp.status_code == 200, verify_resp.text
    return verify_resp.json()


async def make_db_user(db: AsyncSession, *, label: str = "user") -> User:
    """ORM-level verified user for service tests that skip the HTTP flow entirely."""
    user = User(
        email=f"{label}-{uuid.uuid4()}@example.com",
        password_hash="x",
        display_name=label,
        email_verified_at=datetime.now(UTC),
    )
    db.add(user)
    await db.flush()
    return user


async def make_db_dashboard(db: AsyncSession, owner: User, *, name: str = "Board") -> Dashboard:
    """Build an ORM-level dashboard for service tests.

    `resource_shares.resource_id` has a real FK to this table, so a share test cannot invent a
    dashboard id.
    """
    dashboard = Dashboard(user_id=owner.id, name=name)
    db.add(dashboard)
    await db.flush()
    return dashboard


async def current_user(client: AsyncClient) -> dict:
    resp = await client.get("/api/auth/me")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def register_client(
    email: str,
    *,
    display_name: str = "Member",
    password: str = "test-password-123",
) -> AsyncClient:
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await client.__aenter__()
    await register_user(client, email, display_name=display_name, password=password)
    return client


async def create_dashboard(client: AsyncClient, *, name: str = "Test Board", **kwargs) -> dict:
    set_csrf(client)
    payload = {"name": name} | kwargs
    resp = await client.post("/api/dashboards", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def create_list(client: AsyncClient, dashboard_id: str, **kwargs) -> dict:
    set_csrf(client)
    payload = {"name": "Shopping", "list_type": "checklist", "dashboard_id": dashboard_id} | kwargs
    resp = await client.post("/api/lists", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def create_list_item(client: AsyncClient, list_id: str, *, text: str = "Milk") -> dict:
    set_csrf(client)
    resp = await client.post(f"/api/lists/{list_id}/items", json={"text": text})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def create_calendar_event(client: AsyncClient, dashboard_id: str, **kwargs) -> dict:
    set_csrf(client)
    payload = {
        "title": "Dentist",
        "starts_at": "2026-04-10T14:00:00+00:00",
        "ends_at": "2026-04-10T15:00:00+00:00",
        "timezone": "UTC",
        "all_day": False,
        "dashboard_id": dashboard_id,
    } | kwargs
    resp = await client.post("/api/calendar/events", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def share_dashboard(owner: AsyncClient, dashboard_id: str, member: AsyncClient, role: str = "editor") -> None:
    """Grant access the way the product does: mint an invite as the owner, redeem it as the member.

    Every share passes through consent, so test setup exercises the same path a user takes.
    """
    set_csrf(owner)
    minted = await owner.post(f"/api/dashboards/{dashboard_id}/invites", json={"role": role})
    assert minted.status_code == 201, minted.text
    set_csrf(member)
    accepted = await member.post(f"/api/invites/{minted.json()['code']}/accept")
    assert accepted.status_code == 200, accepted.text
