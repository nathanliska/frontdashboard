"""The session label names a browser family and a platform, never the string that produced it."""

import pytest
from fastapi.datastructures import Headers
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.device import device_label
from app.models.session import UserSession

_CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
_SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
_EDGE_ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0"
_CHROME_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1"
)
_SAMSUNG = (
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36"
)


@pytest.mark.parametrize(
    ("agent", "label"),
    [
        (_CHROME_WIN, "Chrome on Windows"),
        (_CHROME_WIN + " Edg/131.0.0.0", "Edge on Windows"),
        (_CHROME_WIN + " OPX/1.0.0.0", "Opera on Windows"),
        (_EDGE_ANDROID, "Edge on Android"),
        (_SAFARI_MAC, "Safari on Mac"),
        (_CHROME_IPHONE, "Chrome on iPhone"),
        ("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", "Firefox on Linux"),
        (_SAMSUNG, "Samsung Internet on Android"),
        ("curl/8.5.0", None),
        ("", None),
    ],
)
def test_device_label_names_the_family_not_the_engine(agent: str, label: str | None) -> None:
    assert device_label(Headers({"user-agent": agent} if agent else {})) == label


async def test_a_sign_in_records_the_label_and_nothing_else_about_the_client(auth_client: AsyncClient, db_session: AsyncSession) -> None:
    resp = await auth_client.post(
        "/api/auth/login",
        json={"email": "testuser@example.com", "password": "testpassword123"},
        headers={"user-agent": _CHROME_WIN},
    )
    assert resp.status_code == 200, resp.text

    rows = (await auth_client.get("/api/auth/sessions")).json()["items"]
    assert {row["device_name"] for row in rows} == {"Chrome on Windows", None}
    assert _CHROME_WIN not in str(rows)

    stored = (await db_session.execute(select(UserSession).where(UserSession.device_name.is_not(None)))).scalar_one()
    assert (stored.device_name, stored.ip_hash, stored.user_agent_hash) == ("Chrome on Windows", None, None)
