from httpx import AsyncClient

from tests.helpers import register_client


async def test_search_users_requires_auth(client: AsyncClient) -> None:
    resp = await client.get("/api/users/search", params={"q": "a"})
    assert resp.status_code == 401


async def test_search_users_matches_email_and_excludes_self(auth_client: AsyncClient) -> None:
    alpha = await register_client("alpha@example.com", display_name="Alpha")
    bravo = await register_client("bravo@example.com", display_name="Bravo")
    try:
        resp = await auth_client.get("/api/users/search", params={"q": "example.com"})
        assert resp.status_code == 200
        payload = resp.json()
        assert [user["display_name"] for user in payload] == ["Alpha", "Bravo"]
        assert all(user["email"] != "testuser@example.com" for user in payload)

        email_resp = await auth_client.get("/api/users/search", params={"q": "bravo@"})
        assert email_resp.status_code == 200
        assert [user["email"] for user in email_resp.json()] == ["bravo@example.com"]
    finally:
        await alpha.__aexit__(None, None, None)
        await bravo.__aexit__(None, None, None)
