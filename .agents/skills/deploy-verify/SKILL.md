---
name: "deploy-verify"
description: "Smoke-check the live site over HTTPS after a deploy — serving contract, cache headers, bundle reachability, SPA fallback, CSP and security headers. Read-only. Use after a deploy, when asked to 'check the deploy', or when the site looks broken in production."
---

# Deploy Verification

Confirm what the public site is actually serving. Everything here is a `GET` or a `HEAD` from
outside; it needs no access to the host and changes nothing.

**Read-only, without exception.** Never send a `POST`, `PATCH`, `PUT` or `DELETE` to production —
there are real users and real data behind it. Never register an account, never redeem an invite.
Rate-limit and CSRF behaviour belong in `/live-verify` against the throwaway stack.

Read the site from config rather than hard-coding it — the deployment's hostname is not this skill's
to know, and `.env.prod` is the file that decides it:

```sh
SITE=$(grep -m1 '^FRONTEND_BASE_URL=' .env.prod | cut -d= -f2- | tr -d '"')
```

`.env.prod` also holds credentials. Never print it, never `cat` it — pull single values with command
substitution, as above.

## 1. The document and the bundle it names

```sh
curl -sD - -o /tmp/doc.html "$SITE/" | grep -iE '^(HTTP|cache-control|content-security-policy|content-type)'
grep -oE '/assets/[^"]+\.js' /tmp/doc.html | head -3
```

- `Cache-Control: no-cache` on the document. **Absent is a finding** — it means browsers guess a
  lifetime from `Last-Modified`, and a stale copy asks for bundles the deploy deleted.
- Then fetch the `index-*.js` the HTML names. It must be `200` and `text/javascript`. A `200` with
  `text/html` is the silent blank-page failure: the browser parses HTML as a module and renders
  nothing. `immutable` is expected on `/assets/*`.

## 2. The invariants that have actually broken here

```sh
curl -sI "$SITE/assets/index-DELETED.js" | head -1           # must be 404, never 200
curl -s "$SITE/not-a-real-page" | grep -c '<div id="root">'  # 1 — SPA fallback, React renders 404
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/api/health/ready"
```

## 3. Headers, and what Cloudflare does to them

Compare against `Caddyfile.prod` and expect these **known** differences, which are Cloudflare's
managed transform, not drift in our config:

| Header | We send | Cloudflare delivers |
|---|---|---|
| `X-Frame-Options` | `DENY` | `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | `same-origin` |
| `Expect-CT`, `X-XSS-Protection` | not set | injected |

CSP `frame-ancestors 'none'` still holds the clickjacking line, so this is accepted, not a finding.

Cloudflare also injects two scripts our CSP blocks: the Web Analytics beacon
(`static.cloudflareinsights.com`) and an inline `challenge-platform` block. **Both are expected.**
Web Analytics is on by choice; the beacon collecting nothing is a known, accepted trade. Do not
re-raise it as a problem.

## 4. If a static asset looks stale

Purge the Cloudflare cache first — never rebuild. That is a standing rule in the root `AGENTS.md`,
and with `no-cache` now on the document the edge is the only layer that can still hold one.

## Report

One short table: check, result, verdict. Lead with anything that failed. If everything passes, say
so in a line — a clean deploy does not need paragraphs. Quote the request and response for any
failure so it can be acted on without re-running this.
