"""ASGI middleware."""

import contextlib
from collections.abc import Awaitable, Callable
from time import perf_counter
from typing import Any

from app import metrics
from app.api import API_PREFIX

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

# Prometheus reports its own scrape health as `up` and `scrape_duration_seconds`, so counting the
# scrape here answers nothing and grows on a fixed interval until it dwarfs real traffic.
# `/api/health/ready` is deliberately *not* here: Caddy proxies it publicly, so its volume is a
# signal about the outside world rather than about the container.
_UNCOUNTED_ROUTES = frozenset({"/metrics"})


class ResponseStatusMiddleware:
    """Count responses by route template and status class.

    Pure ASGI rather than `BaseHTTPMiddleware`: that base class reads a streaming response to
    completion before forwarding it, which would buffer SSE — the one behaviour the proxy chain,
    the Caddy `flush_interval -1`, and the compression exemption all exist to preserve.

    Only the status line is inspected; the body is passed straight through untouched.
    """

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = perf_counter()
        responded = False

        async def send_wrapper(message: Message) -> None:
            nonlocal responded
            if message["type"] == "http.response.start":
                responded = True
                _observe(scope, message["status"], started)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            # `add_middleware` mounts this inside ServerErrorMiddleware, which builds the 500 above
            # here — so a crash never reaches `send_wrapper` and would go uncounted. Guarded on
            # `responded` because a stream that dies mid-body already counted its own status.
            if not responded:
                _observe(scope, 500, started)
            raise


def _observe(scope: Scope, status: int, started: float) -> None:
    """Record one response, unless its route is deliberately uncounted.

    Suppressing covers the label lookup as well as the counters: this runs on the exception path,
    where raising would replace the crash being reported with one from the code reporting it.
    """
    with contextlib.suppress(Exception):
        route = _route_label(scope)
        if route not in _UNCOUNTED_ROUTES:
            metrics.observe_response(scope.get("method", ""), route, status, seconds=perf_counter() - started)


def _route_label(scope: Scope) -> str:
    """The matched route's template, or a constant for anything that matched nothing.

    Starlette writes the route into the scope during routing, which has happened by the time the
    response starts. Falling back to the raw path would mint a series per unmatched URL, which is
    what a scanner hitting random paths would otherwise cost.

    The route's own path is router-relative — `/auth/me`, not `/api/auth/me` — because the API
    router is included rather than flattened, the same nesting that makes an audit over
    `app.routes` see nothing. The prefix is restored from the request path so the label matches
    what a reader would type.
    """
    route = scope.get("route")
    path = getattr(route, "path", None)
    if not isinstance(path, str):
        return "unmatched"
    raw = scope.get("path", "")
    if isinstance(raw, str) and raw.startswith(API_PREFIX) and not path.startswith(API_PREFIX):
        return f"{API_PREFIX}{path}"
    return path
