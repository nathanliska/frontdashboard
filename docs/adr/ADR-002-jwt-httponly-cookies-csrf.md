# ADR-002: Credential in HttpOnly Cookies + Origin Check and CSRF Double-Submit

**Date:** 2026-07-20
**Amended:** 2026-07-28 — the credential is no longer a JWT, and the cookies carry the `__Host-`
prefix in production. The transport decision below is unchanged.
**Amended:** 2026-07-29 — added `Origin` verification alongside the double-submit token.

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

Carry the credential in **HttpOnly cookies** and defend against CSRF with two independent checks: a
**double-submit token** (a readable CSRF cookie whose value the client echoes in a request header,
which the server compares) and **`Origin` verification** against the configured origins.

- The credential is an **opaque session token**, not a JWT ([ADR-003](ADR-003-first-class-sessions.md)).
  This ADR governs how it is transported, not what it is.
- **`Origin` is checked first, and is additive rather than a replacement.** It is a forbidden
  header, so script cannot set it: a value that is not ours proves a cross-site caller regardless of
  what the cookies say. A request that omits `Origin` is *not* rejected — it still has to satisfy
  the token pair — because rejecting on absence would be a new way to lock out a working client for
  no gain. The allowlist is `frontend_base_url` plus `cors_origins_list`, so a non-default host is
  configured through the knob that already exists for it rather than a new one.
- Every **non-GET** route declares `_csrf: None = Depends(require_csrf)`. CSRF is a *dependency*,
  not middleware — omit it and the route silently accepts cross-site requests
  ([AGENTS.md](../../AGENTS.md)).
- Cookies are `HttpOnly` (except the CSRF cookie, which must be readable), `Secure` in production,
  `SameSite=Lax`, and carry **no `Domain` attribute**, so they are host-only.
- In production both cookies are named with the **`__Host-` prefix** (`__Host-session`,
  `__Host-csrf_token`), which browsers refuse to store unless the cookie is `Secure`, `path=/` and
  has no `Domain` — closing the subdomain-injection route above. Development runs on plain HTTP,
  where the prefix would be rejected, so the names are environment-dependent
  (`settings.session_cookie_name` / `csrf_cookie_name`); the client tries both, prefixed first.
- `SameSite=Lax` is load-bearing and only sufficient because **no GET route mutates state** — Lax
  still sends cookies on top-level cross-site GET navigation.
- The frontend's single network entry point, `apiFetch` (`api/client.ts`), sets the CSRF header and
  includes credentials on every call. Components never call `fetch` directly
  ([AGENTS.md](../../AGENTS.md)).
- No credential is ever placed in `localStorage`.

## Consequences

- **XSS can't read the session token**: the primary credential is HttpOnly. XSS can still *act* as
  the user while the page is open, but it can't walk away with a durable token.
- **CSRF cost is one dependency per route**: cheap, but easy to forget — hence the hard rule and the
  single choke-point in `apiFetch` so the header is never hand-managed.
- **Cookie names differ between environments, and renaming one does not remove the old.** Nothing
  may hard-code a name: the server reads through `Cookie(alias=...)`, and `getCsrfToken` tries the
  names **in order, prefixed first**. It must not treat the prefix as optional in a single pattern —
  a browser holding a superseded `csrf_token` carries both, and an optional-prefix match returns
  whichever the browser listed first. That shipped on 2026-07-28 and 403'd every mutation in
  production, logout included, so the app offered no way out of it. Deleting a prefixed cookie needs
  `Secure` too, or the browser rejects the deletion for an invalid prefix and keeps it.
- **The Origin allowlist is not branched on environment, and that costs LAN development.** Vite
  binds all interfaces, so browsing the dev server by its LAN address (testing on a phone — which
  this product is *for*) makes the browser send that address as `Origin`, and it must be added to
  `CORS_ORIGINS` or every mutation 403s. Skipping the check in development was rejected: tests run
  under `environment=development`, so that branch would disable the check in the suite as well —
  the same "risk lives where no test runs" shape as the cookie-name bug above. Rejections log the
  origin, so the 403 is diagnosable rather than mysterious.
- **Two independent CSRF checks, and only one of them holds state.** The double-submit pair can
  desynchronise — it did. `Origin` cannot: there is nothing to go stale, nothing to rename, and
  nothing for a deploy to leave behind. If the token pair is ever retired, this is what remains,
  and the dual-name reader would go with it.
- **A mutating GET route would silently break the model** — it would be reachable cross-site with
  the session cookie attached and no CSRF check, since CSRF is only wired to non-GET.
- **Cross-origin API access is not cookie-based**: a separate opaque-bearer path would be needed for
  that; the cookie model assumes same-origin browser use.
