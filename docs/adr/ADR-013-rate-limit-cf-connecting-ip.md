# ADR-013: Rate Limiting — Per-Route Limits Keyed on `CF-Connecting-IP`

**Date:** 2026-07-20 (amended 2026-07-30: limits extended to every mutating route; amended 2026-08-06:
buckets moved to Redis with an in-memory fallback; amended 2026-08-19: engine swapped to Valkey,
protocol and client unchanged, hash-field counters rejected on measurement)

## Context

Auth endpoints are rate-limited to blunt brute force. A rate limiter must key on the *real* client,
but the backend never sees the client directly: production traffic arrives through a **non-public
Cloudflare Tunnel**, so the peer address the app observes is the tunnel/proxy, not the user. Keying
on the observed peer address would collapse every client into one shared bucket — either locking
everyone out together or, more likely, making per-client limits meaningless.

## Decision

Key the limiter on **`CF-Connecting-IP`**, the real client IP that Cloudflare sets, falling back to
the peer address in development (where there's no Cloudflare in front).

Because the origin is a **non-public Cloudflare Tunnel**, `CF-Connecting-IP` is authoritative here —
a client can't reach the origin directly to spoof the header, since the only path in is through
Cloudflare. The header is honored **only when the peer is private or loopback**; a public peer
means the request bypassed the tunnel, so its header is attacker-controlled and is ignored.

Buckets live in **Valkey**, so a limit belongs to the deployment rather than to one process. When
it is unreachable the limiter falls back to per-process in-memory buckets and slowapi restores the
shared store once it answers again. The two alternatives were rejected: slowapi's default re-raises,
which turns every write into a 500 including login and password reset, and `swallow_errors` lets them
through unbounded — dropping the 10/min login, 10/min reset-token and 3/min email-bomb limits at once
on a deployment where anyone can register. The fallback is strictly weaker than the shared store only once
replicas exist; at one process it is exactly what ran before.

The store is configured with bounded socket timeouts **and a bounded retry count**, the retry being
the one that matters: redis-py retries ten times with exponential backoff, so a 0.25s connect ceiling
still cost **5.43s** per write against a blackholed address and **45s** against a stopped host. One
retry brings that to **0.50s**. Otherwise the fallback trades a security hole for a latency one — the
writes it exists to keep serving are exactly the ones left waiting.

The instance is **bundled in each stack** rather than shared with the host's other apps, which is
also what Immich and Paperless do. A shared instance would need ACLs to keep another app off our
keys — ACLs that do not survive a restart without an `aclfile`, and whose `-@dangerous` category
denies `SELECT`, so database numbers cannot substitute for them. `REDIS_URL` stays overridable for a
deployment that wants an external instance; the bundled service is the supported shape.

Bundling does **not** make the DNS cost go away. A compose service name stops resolving whenever its
own container is down — a crash, an OOM kill, a `restart: unless-stopped` cycle — not only when the
stack is coming down. Measured against a stopped container, on one worker and then on two: writes
kept succeeding but took **8-15s each**, which to a user is not a degradation but a failure. GETs
stayed at ~16ms throughout, so this is confined to the write path.

The cause is that **slowapi's storage is a synchronous Redis client called on the event loop**.
slowapi 0.1.10 has one `Limiter` and imports only `limits.storage`, never `limits.aio.storage`,
which `limits` 5.8 does ship — so no configuration reaches this. Measured with a ticker task
alongside: `strategy.hit()`, which is exactly what `@limiter.limit` calls per request, froze the
loop for its whole duration (0.50s call, 0.52s largest tick gap). Against a stopped container that
duration was **7.68-7.70s**.

So the unit is not a slow write but a **stalled worker**: every concurrent request, every SSE
stream and the readiness endpoint wait it out together. Nothing at the application layer can bound
it either — a timeout callback cannot fire on a frozen loop. Healthy, the same call costs
**0.50ms p50 / 0.73ms p99**, which is why this is invisible in normal operation and why it is not
worth replacing slowapi over today.

Every mutating route additionally carries **`@limiter.limit(WRITE_LIMIT)` applied per route**, not
an application-wide default. slowapi's app-wide limit runs in middleware that resolves handlers
through `app.routes`, which cannot see through this FastAPI version's included-router nesting — so
it silently exempts everything. Per-route decoration is the only form that actually applies, and
`test_rate_limit_coverage.py` fails the build when a mutating route is added without one.

## Consequences

- **Per-client auth limits actually isolate**: each real client gets its own bucket instead of
  sharing the proxy's, so one abuser's attempts don't consume everyone's budget (and vice versa).
- **Trusting the header is safe *only* because of the tunnel topology**: this decision depends on the
  origin being unreachable except through Cloudflare. If the origin were ever exposed directly, the
  header would become spoofable and this keying would be unsafe.
- **Dev parity via fallback**: local development, with no Cloudflare, falls back to the peer address
  so the limiter still works without special-casing.
- **Rate is bounded; volume is not.** `WRITE_LIMIT` is generous on purpose — the key is a client IP
  a whole household shares behind one NAT — so it stops a runaway client or a crude script, not a
  patient one. Total storage per account is bounded separately, by the quotas in
  [ADR-020](ADR-020-resource-quotas.md).
- **A forgotten decorator is a build failure, not a silent hole**, because the coverage test
  enumerates mutating routes rather than trusting review. Note the same nesting quirk defeats any
  audit written over `app.routes`, which sees four docs routes and one `_IncludedRouter`.
- **A limit is the deployment's, not a process's**, so adding a replica no longer multiplies every
  bucket by N. This had to land before the first replica rather than with it: registration is open to
  the internet, so silently N-ing the abuse limits is a security regression rather than a scaling
  detail ([ADR-004](ADR-004-sse-over-websocket.md), #21/#45 in [TODO.md](../TODO.md)).
- **The store being down degrades, it does not fail**: limits stay enforced per process and recover on
  their own. No error and no failed request reports it, so two things do. The app attaches a handler
  to slowapi's logger, which ships a discarding one by default, or the single WARNING announcing the
  fallback would go nowhere. And `rate_limit_store_degraded` carries the state as a **gauge**, since
  a rare event counted lazily gives `increase()` nothing to diff against and reads 0 through the
  outage it exists to show. It is last-known state, not live: slowapi only re-checks the store when
  a limited request arrives, so with no writes it stays 1 until one comes. The alert on it is a
  **warning** while the stack runs one replica, because the fallback is then exactly what that one
  process already enforced; the second replica is what makes losing the shared store a real weakening
  and promotes it.
- **The stack brings its own store**, so no deploy step sets `REDIS_URL` and forgetting one is not a
  failure mode. Set to an *empty* value it refuses to start, because slowapi reads that as
  `memory://` and would otherwise run permanently on per-process limits without failing.
- **An unreachable store stalls the whole worker, not just the write that noticed.** The limiter's
  storage call blocks the event loop for as long as it takes to fail — 7.7s against a stopped
  container — so concurrent requests and open SSE streams wait with it. Writes still complete and
  GETs measured 16ms when they missed a stall, but the readiness endpoint is served by that same
  loop and the container health check allows 5s, so a coinciding check fails. Compose does not
  restart on unhealthy, so the consequence is a wrong health signal rather than a restart loop.
  Tracked as #64; not fixed here, because the healthy path costs 0.50ms and the fix is replacing
  slowapi.
- **Hash fields are not the storage layout** (considered 2026-08-19). Valkey 9's `HEXPIRE` makes one
  hash per client with a field per route expressible, and `limits` documents the extension point —
  subclass `Storage`, declare a `STORAGE_SCHEME` — so no fork is involved. Rejected on measurement:
  51 top-level counters cost 7,720 bytes against 3,912 for the equivalent hash, a 3.7 KiB saving for
  a client that touched every limited route inside one minute, against a 64 MiB cap. The cost is
  parsing `RateLimitItem.key_for`'s `/`-joined key to find where the client ends and the route
  begins — an internal format whose drift would misgroup buckets silently rather than raise. Valkey's
  own hash-field guidance does not mention rate limiting, Redis's names it only in passing beside the
  `INCR`/`EXPIRE` it leads with, and `limits` uses no hash command in any backend. #64 would discard
  the layout regardless: `limits.aio`'s sliding and moving windows are sorted-set based.
