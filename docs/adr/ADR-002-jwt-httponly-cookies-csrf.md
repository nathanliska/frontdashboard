# ADR-002: Credential in HttpOnly Cookies + CSRF Double-Submit

**Date:** 2026-07-20
**Amended:** 2026-07-28 — the credential is no longer a JWT, and the cookies carry the `__Host-`
prefix in production. The transport decision below is unchanged.

## Context

The app is a browser SPA talking to a FastAPI backend. It needs a credential transport that
survives page reloads and is not readable by JavaScript, so that an XSS foothold can't exfiltrate a
long-lived credential. The two common options:

- **Bearer token in `localStorage`**: simple to send (`Authorization` header, immune to CSRF), but
  readable by any script on the page — one XSS and the token is stolen.
- **Token in an HttpOnly cookie**: invisible to JavaScript, sent automatically — but automatic
  sending is exactly what makes it forgeable cross-site (CSRF).

A cookie is also only as isolated as its **name**. Without the `__Host-` prefix a cookie can be set
for a parent domain by any sibling subdomain, and the browser will send that one alongside the
host-only cookie — so a compromised or attacker-controlled neighbour on the same registrable domain
can plant a session value of their choosing.

## Decision

Carry the credential in **HttpOnly cookies** and defend against CSRF with a **double-submit
token**: a readable CSRF cookie whose value the client echoes in a request header, which the server
compares.

- The credential is an **opaque session token**, not a JWT ([ADR-003](ADR-003-first-class-sessions.md)).
  This ADR governs how it is transported, not what it is.
- Every **non-GET** route declares `_csrf: None = Depends(require_csrf)`. CSRF is a *dependency*,
  not middleware — omit it and the route silently accepts cross-site requests
  ([backend/CLAUDE.md](../../backend/CLAUDE.md)).
- Cookies are `HttpOnly` (except the CSRF cookie, which must be readable), `Secure` in production,
  `SameSite=Lax`, and carry **no `Domain` attribute**, so they are host-only.
- In production both cookies are named with the **`__Host-` prefix** (`__Host-session`,
  `__Host-csrf_token`), which browsers refuse to store unless the cookie is `Secure`, `path=/` and
  has no `Domain` — closing the subdomain-injection route above. Development runs on plain HTTP,
  where the prefix would be rejected, so the names are environment-dependent
  (`settings.session_cookie_name` / `csrf_cookie_name`); the client matches both.
- `SameSite=Lax` is load-bearing and only sufficient because **no GET route mutates state** — Lax
  still sends cookies on top-level cross-site GET navigation.
- The frontend's single network entry point, `apiFetch` (`api/client.ts`), sets the CSRF header and
  includes credentials on every call. Components never call `fetch` directly
  ([frontend/CLAUDE.md](../../frontend/CLAUDE.md)).
- No credential is ever placed in `localStorage`.

## Consequences

- **XSS can't read the session token**: the primary credential is HttpOnly. XSS can still *act* as
  the user while the page is open, but it can't walk away with a durable token.
- **CSRF cost is one dependency per route**: cheap, but easy to forget — hence the hard rule and the
  single choke-point in `apiFetch` so the header is never hand-managed.
- **Cookie names differ between environments.** Nothing may hard-code them: the server reads them
  through `Cookie(alias=...)` and the client's `getCsrfToken` matches with an optional prefix. A
  literal `"csrf_token"` written anywhere would work in dev and fail in production only.
- **A mutating GET route would silently break the model** — it would be reachable cross-site with
  the session cookie attached and no CSRF check, since CSRF is only wired to non-GET.
- **Cross-origin API access is not cookie-based**: a separate opaque-bearer path would be needed for
  that; the cookie model assumes same-origin browser use.
