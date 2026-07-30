---
name: "live-verify"
description: "Build the real production images, run them against a throwaway database, and drive the app in a browser (Chrome DevTools MCP) to verify a change works. Use after any user-visible change, when asked to 'test it live', 'run the app', 'verify in the browser', or to check for blank pages, stray refetches, 404 handling or caching problems."
---

# Live Verification

Run the images that actually ship and exercise them in a real browser. `make test` proves units and
API behaviour; this proves the thing a user loads. It is the only check here that sees a blank page,
a stray GET after a write, a missing bundle, or a cookie the browser refuses.

Deliberately the **production** images rather than `make dev-up`: every failure this project has
shipped in that class — the `__Host-` cookie rename, HTML served with no `Cache-Control`, a missing
bundle answered with `index.html` — existed only in the built artifact. The dev stack cannot see them.

## When to use

- After a user-visible change, before saying it works.
- When asked to test live, run the app, or reproduce a UI bug.
- Before a deploy that touches the frontend, `Caddyfile.prod`, or either `Dockerfile.prod`.

## 1. Build and boot

```sh
docker build -t frontdashboard-backend:verify -f backend/Dockerfile.prod backend/
docker build -t frontdashboard-frontend:verify -f frontend/Dockerfile.prod .
docker compose -f docker-compose.verify.yml up -d --wait
```

The app is on **http://localhost:8080**. The backend runs `alembic upgrade head` on start, so the
schema builds itself.

**Never delete `name: frontdashboard-verify` from that compose file, and never override it with
`-p`.** Without it Compose derives the project from the directory, collides with the dev stack's `db`
service, and recreates that container with the real `frontdashboard_pgdata` volume attached — a
verify run pointed straight at the development database. That happened once; the isolated project
name and the file's own volume are what prevent it.

## 2. Get a usable account

`ENVIRONMENT=production` is set on purpose, which disables the `.dev-mail` outbox — so there is no
verification link to read, and login refuses an unverified account. Register over the API, then
verify with SQL against the throwaway database:

```sh
curl -sX POST http://localhost:8080/api/auth/register \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8080' \
  -d '{"email":"verify@example.com","password":"verify-password-123","display_name":"Verify"}'

docker compose -f docker-compose.verify.yml exec -T db \
  psql -qU frontdashboard -c "UPDATE users SET email_verified_at = now() WHERE email = 'verify@example.com';"
```

Login then returns `__Host-session` and `__Host-csrf_token`, which is the point of running
production: the prefixed-cookie path is the one that broke in July and the dev stack never exercises
it. `make seed` is an unimplemented stub — don't reach for it.

Worth knowing for the browser step: `__Host-` requires `Secure`, and browsers only tolerate that over
plain HTTP because `localhost` counts as a trustworthy origin. If sign-in works by curl but not in
the browser, that is the first thing to check, not an app bug.

## 3. Drive it in the browser

Use the `chrome-devtools` MCP tools. Navigate to http://localhost:8080, sign in with the account
above, then exercise whatever changed. The **network panel is the point** — most of this project's
recurring bugs are visible only as request traffic, not as pixels.

**"Target closed" means the browser, not the app.** On WSL the server otherwise auto-selects the
*Windows* `chrome.exe` under `/mnt/c/`, whose CDP pipe resets the moment it starts
([chrome-devtools-mcp#690](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/690)). So
`.mcp.json` runs the server through `sh -c` and resolves `--executablePath` itself, from the newest
**Linux** Chrome in the puppeteer cache, with `$CHROME_PATH` as an override. The shell does the
expanding because Claude Code passes `${VAR}` in `args` through literally — the server then reports
being unable to find a browser "at `${CHROME_PATH}`", which is the tell. Installing a Linux Chrome
alone does not fix this: without the flag it still reaches for `/mnt/c`.

Getting that binary: `npx puppeteer browsers install chrome` is the documented way and has been seen
to fail silently here (exit 1, no output, empty directories). It still earns its keep, because the
empty directory names the version to fetch — and it must match the version this MCP pins, not
whatever `puppeteer@latest` wants. Grep the installed package for it:
`grep -rhoE "'1[0-9]{2}\.0\.[0-9]{4}\.[0-9]+'" ~/.npm/_npx/*/node_modules/chrome-devtools-mcp`. Then
download `https://storage.googleapis.com/chrome-for-testing-public/<version>/linux64/chrome-linux64.zip`
and unpack into `~/.cache/puppeteer/chrome/linux-<version>/` (`unzip` may be absent; Python's
`zipfile` works, but restore the exec bit it drops). A newly installed browser needs a Claude Code
restart — the running server does not retry.

That binary also drives a quick render check with no MCP at all, which is enough to prove a page
mounts:

```sh
CH=$(ls ~/.cache/puppeteer/chrome/*/chrome-linux64/chrome | head -1)
"$CH" --headless --disable-gpu --virtual-time-budget=8000 --dump-dom http://localhost:8080/some-route
```

Check every time, regardless of what changed:

- **No GET after your own write.** A `POST`/`PATCH`/`DELETE` followed by a `GET` of the same
  collection is a bug (`frontend/CLAUDE.md`). The mutation response is the truth; caches are patched
  from it and the SSE echo is suppressed. This has regressed at least four times.
- **No duplicate requests on mount.** StrictMode double-invokes effects; a page fetching twice means
  a missing single-flight or loaded-flag cache.
- **The page actually rendered.** A blank `#root` with no failed request means the bundle never ran.
  The static fallback in `index.html` should say so after 12s.
- **Console is clean** apart from the known Cloudflare beacon CSP violation, which only appears
  behind Cloudflare and so should *not* appear here.

## 4. Check the serving contract

These are cheap, catch real deploy hazards, and need no browser:

```sh
curl -sI http://localhost:8080/                      # Cache-Control: no-cache
curl -sI http://localhost:8080/assets/<hashed>.js    # immutable, text/javascript
curl -sI http://localhost:8080/assets/nope-DELETED.js # 404 — must NOT be 200 text/html
curl -s  http://localhost:8080/not-a-real-page       # index.html, so React renders NotFoundPage
```

A missing asset returning `200 text/html` is the silent blank-page bug — the browser parses HTML as
a module and renders nothing.

And the gates, using the cookie jar from step 2 (`CSRF` is the `__Host-csrf_token` value):

```sh
curl -s -b jar -X PATCH "$S/api/auth/profile" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' -H "X-CSRF-Token: $CSRF" -d '{"display_name":"x"}'
# {"detail":"Cross-origin request rejected"} — and without the header, "CSRF token missing"
```

## 5. Tear down

```sh
docker compose -f docker-compose.verify.yml down
docker volume rm frontdashboard-verify_verify-pgdata   # only when a clean database is wanted
```

**Never `down -v`** (root `CLAUDE.md`) — remove the verify volume by name, as above. Left in place it
keeps the account from the last run, which is usually convenient and occasionally confusing.

## Report

State what was exercised, what the network panel showed, and screenshots for anything visual. If a
check failed, give the request or response that proves it — not a description of it.

## Anti-patterns

- **Don't verify against `make dev-up`.** Unbuilt source hides the whole class of bug this exists for.
- **Don't claim it works from `make test` alone.** Tests mock the network; this is the network.
- **Don't skip the serving-contract checks** because the change looked like "just a component". A
  Vite config or `Caddyfile.prod` edit reaches them, and they cost four curls.
