# Agent 2: Input Validation, Enumeration & Abuse

Account enumeration through response bodies, status codes or timing on register, login, reset,
verification and invite; rate-limit coverage and whether the limit key can be
spoofed through proxy headers; unbounded queries, pagination ceilings and other DoS vectors; mass
assignment through request schemas; error messages that leak internals.

Every non-GET route needs `_csrf: None = Depends(require_csrf)` **and** `@limiter.limit(WRITE_LIMIT)`
with a `request: Request` parameter. A test catches the missing limit; nothing catches a route that
takes the CSRF dependency but validates the wrong thing. Beware any audit looping over `app.routes`
— slowapi's included-router nesting means it can pass having checked nothing.

Key files: `backend/app/routers/auth.py`, `backend/app/routers/invites.py`,
`backend/app/schemas/`, `backend/app/limiter.py`, `backend/app/middleware.py`,
`backend/app/config.py`
