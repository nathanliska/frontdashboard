from httpx import ASGITransport, AsyncClient

from app.main import app

CSRF = "test-csrf-token"


def set_csrf(client: AsyncClient) -> None:
    client.cookies.set("csrf_token", CSRF)
    client.headers.update({"x-csrf-token": CSRF})


async def current_user(client: AsyncClient) -> dict:
    resp = await client.get("/api/auth/me")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def register_client(
    email: str,
    *,
    display_name: str = "Member",
    password: str = "password123",
) -> AsyncClient:
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    await client.__aenter__()
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "display_name": display_name},
    )
    assert resp.status_code == 201, resp.text
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
