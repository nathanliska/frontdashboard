import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

# TODO (step 3): override the DB session dependency here so tests run against
# a separate test database instead of the development database.
# Example:
#   app.dependency_overrides[get_db] = override_get_db

# TODO (step 4): add an `auth_client` fixture that injects a valid JWT cookie
# so authenticated endpoint tests don't need to repeat the login flow.


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
