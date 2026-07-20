from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from tests.helpers import register_client


async def test_search_users_requires_auth(client: AsyncClient) -> None:
    resp = await client.get("/api/users/search", params={"q": "ab"})
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


async def test_search_users_requires_two_characters(auth_client: AsyncClient) -> None:
    resp = await auth_client.get("/api/users/search", params={"q": "a"})
    assert resp.status_code == 422

    padded = await auth_client.get("/api/users/search", params={"q": " a "})
    assert padded.status_code == 422


async def test_search_users_treats_like_wildcards_literally(auth_client: AsyncClient) -> None:
    """A wildcard term must not defeat the two-character minimum.

    Unescaped, q="%%" becomes ILIKE '%%%%' and matches every row, dumping display names
    and full email addresses to any authenticated caller who knows nothing about anyone.
    """
    victim = await register_client("wildcard-victim@example.com", display_name="Wildcard Victim")
    try:
        for term in ("%%", "%", "_%", "a%"):
            resp = await auth_client.get("/api/users/search", params={"q": term})
            assert resp.status_code in (200, 422), resp.text
            if resp.status_code == 200:
                assert all(user["email"] != "wildcard-victim@example.com" for user in resp.json()), f"term {term!r} leaked a user it should not match"

        # A literal match on the same characters still works.
        literal = await register_client("100%cotton@example.com", display_name="Percent Person")
        try:
            resp = await auth_client.get("/api/users/search", params={"q": "100%c"})
            assert resp.status_code == 200
            assert [user["email"] for user in resp.json()] == ["100%cotton@example.com"]
        finally:
            await literal.__aexit__(None, None, None)
    finally:
        await victim.__aexit__(None, None, None)


async def test_search_users_excludes_unverified_and_deleted_users(
    auth_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    now = datetime.now(UTC)
    db_session.add_all(
        [
            User(
                email="active-search@example.com",
                password_hash="x",
                display_name="Search Active",
                email_verified_at=now,
            ),
            User(
                email="unverified-search@example.com",
                password_hash="x",
                display_name="Search Unverified",
            ),
            User(
                email="deleted-search@example.com",
                password_hash="x",
                display_name="Search Deleted",
                email_verified_at=now,
                deleted_at=now,
            ),
        ]
    )
    await db_session.flush()

    resp = await auth_client.get("/api/users/search", params={"q": "Search"})

    assert resp.status_code == 200
    assert [user["email"] for user in resp.json()] == ["active-search@example.com"]
