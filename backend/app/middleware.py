"""ASGI middleware."""

from collections.abc import Awaitable, Callable
from typing import Any

from app import metrics

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


class ResponseStatusMiddleware:
    """Count response statuses by class.

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

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                metrics.observe_status(message["status"])
            await send(message)

        await self.app(scope, receive, send_wrapper)
