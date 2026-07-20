# ADR-002: JWT in HttpOnly Cookies + CSRF Double-Submit

**Date:** 2026-07-20

## Context

The app is a browser SPA talking to a FastAPI backend. It needs an auth-token transport that
survives page reloads and is not readable by JavaScript, so that an XSS foothold can't exfiltrate a
long-lived credential. The two common options:

- **Bearer token in `localStorage`**: simple to send (`Authorization` header, immune to CSRF), but
  readable by any script on the page — one XSS and the token is stolen.
- **Token in an HttpOnly cookie**: invisible to JavaScript, sent automatically — but automatic
  sending is exactly what makes it forgeable cross-site (CSRF).

## Decision

Store the access and refresh JWTs in **HttpOnly cookies** and defend against CSRF with a
**double-submit token**: a readable CSRF cookie whose value the client echoes in a request header,
which the server compares.

- Every **non-GET** route declares `_csrf: None = Depends(require_csrf)`. CSRF is a *dependency*,
  not middleware — omit it and the route silently accepts cross-site requests
  ([backend/CLAUDE.md](../../backend/CLAUDE.md)).
- The frontend's single network entry point, `apiFetch` (`api/client.ts`), sets the CSRF header and
  includes credentials on every call. Components never call `fetch` directly
  ([frontend/CLAUDE.md](../../frontend/CLAUDE.md)).
- No tokens are ever placed in `localStorage`.

## Consequences

- **XSS can't read the session token**: the primary credential is HttpOnly. XSS can still *act* as
  the user while the page is open, but it can't walk away with a durable token.
- **CSRF cost is one dependency per route**: cheap, but easy to forget — hence the hard rule and the
  single choke-point in `apiFetch` so the header is never hand-managed.
- **JWT carries `email`**: any route that mutates identity fields must re-issue the access cookie
  (`_set_access_cookie`), or the token's embedded claims go stale (profile rename, password change
  already do this).
- **Cross-origin API access is not cookie-based**: a separate opaque-bearer path would be needed for
  that; the cookie model assumes same-origin browser use.
