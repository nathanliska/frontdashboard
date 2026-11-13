# Agent 4: Frontend & Serving

The `apiFetch` network boundary and `parseJson` validation, what a `401` versus a `403` is allowed
to do to session state, XSS through `dangerouslySetInnerHTML` or user-controlled URLs, open
redirects on post-auth navigation, anything sensitive reaching `localStorage` or the client bundle,
CSP and security headers, cache-control on the document versus hashed assets, and container
hardening.

The traps: only `401` means logged out — a `403`, `5xx`, timeout or network rejection that clears
the session is a denial-of-service on the user. Retries are GET-only. Session state lives in one
opaque cookie; a token in `localStorage` is a finding, not a style preference.

Key files: `frontend/src/api/http.ts`, `frontend/src/api/client.ts`,
`frontend/src/stores/auth.ts`, `frontend/src/hooks/useSSE.ts`, `Caddyfile.prod`,
`frontend/Dockerfile.prod`, `backend/Dockerfile.prod`, `docker-compose.prod.yml`
