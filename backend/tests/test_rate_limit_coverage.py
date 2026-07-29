"""Every mutating route carries a rate limit.

`test_limiter.py` proves the mechanism — login really answers 429 on the eleventh attempt. What it
cannot prove is *coverage*, and coverage is the weak point of the per-route approach: a limit is a
decorator someone has to remember, exactly like `require_csrf`. This is the test that makes
forgetting it a build failure instead of an unbounded endpoint nobody notices.

The application-wide alternative was tried and reverted. slowapi enforces `application_limits` in a
middleware that resolves the handler via `app.routes`, which cannot see through this FastAPI
version's included-router nesting; it therefore treats every request as exempt. Measured, not
assumed: 1260 requests through the real app produced zero 429s.
"""

from fastapi.routing import APIRoute

from app.main import app

# Public pre-auth endpoints declare their own tighter limits and are covered by the same assertion;
# nothing is exempt. Kept as an explicit empty set so adding an exemption is a deliberate edit.
_EXEMPT: set[str] = set()


def _all_api_routes() -> list[APIRoute]:
    """Walk nested routers.

    `app.routes` holds five entries in this FastAPI version — four docs routes and an
    `_IncludedRouter` — so iterating it directly examines none of the application's own routes and
    any assertion over it passes vacuously. That mistake is what hid this gap in the first place.
    """
    found: list[APIRoute] = []
    seen: set[int] = set()

    def walk(node: object) -> None:
        if id(node) in seen:
            return
        seen.add(id(node))
        for route in getattr(node, "routes", []):
            if isinstance(route, APIRoute):
                found.append(route)
                continue
            for attr in ("original_router", "router", "app"):
                child = getattr(route, attr, None)
                if child is not None:
                    walk(child)

    walk(app.router)
    return found


def test_the_route_walk_actually_finds_routes() -> None:
    """Guards the guard: if the walk breaks, every assertion below would pass having checked nothing."""
    routes = _all_api_routes()
    assert len(routes) > 50, f"route walk found only {len(routes)} routes — it is not reaching the app's routers"


def test_every_mutating_route_is_rate_limited() -> None:
    limited = set(app.state.limiter._route_limits)
    unlimited = []
    for route in _all_api_routes():
        methods = set(route.methods or ())
        if not methods - {"GET", "HEAD", "OPTIONS"}:
            continue
        module = getattr(route.endpoint, "__module__", "")
        func = getattr(route.endpoint, "__name__", "")
        if f"{module}.{func}" in _EXEMPT or f"{module}.{func}" in limited:
            continue
        unlimited.append(f"{sorted(methods - {'HEAD', 'OPTIONS'})[0]} {route.path}")

    assert not unlimited, "mutating routes with no rate limit — add @limiter.limit(WRITE_LIMIT):\n  " + "\n  ".join(sorted(unlimited))
