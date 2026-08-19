# ADR-004: SSE (Not WebSocket), One Multiplexed Connection Per User

**Date:** 2026-07-20 (amended 2026-07-28 — HTTP-error reconnect no longer signs anyone out; amended
2026-08-04 — Redis named as the backplane; amended 2026-08-07 — backplane built as a stream, pub/sub
rejected on measurement; amended 2026-08-16 — overflow resyncs in place instead of ending the
stream; amended 2026-08-19 — engine swapped to Valkey, protocol and client unchanged)

## Context

The dashboard needs real-time updates: a list item checked on a phone should appear on the wall
display, notifications should push, agendas should stay live. The data flow is overwhelmingly
**server → client**; clients mutate via ordinary REST, not over the live channel.

The transport choices:

- **WebSocket**: full duplex, but that duplex is unused here, and it needs its own auth handshake,
  reconnection logic, and proxy configuration; behind Caddy/Cloudflare it's more moving parts.
- **Server-Sent Events (SSE)**: one-way server→client over plain HTTP, works through the existing
  cookie auth and reverse proxy, has built-in reconnection with `Last-Event-ID`.

## Decision

Use **SSE**. Each user holds **one multiplexed** `EventSource('/api/sse')` connection carrying every
event type (lists, calendar, dashboards, notifications). An in-memory manager fans server events out
to connected clients with bounded per-client queues.

- Connection primes with a `connected` event and asks for a `resync` on reconnect via
  `Last-Event-ID`.
- A client whose queue overflows keeps its stream: the backlog is **coalesced into one in-place
  resync frame**, and frames arriving before it is delivered are dropped as covered by the refetch
  it orders — rather than the client staying connected and silently deaf, or being disconnected
  back into the very burst that overflowed it.
- An HTTP-error-rejected stream (which `EventSource` never auto-retries) reconnects on jittered
  exponential backoff (1s → 30s cap), indefinitely, and **never logs anyone out** — a rejected
  stream means the server is unhappy, which says nothing about the session. Every fourth attempt
  probes `/auth/me`, so a genuinely signed-out tab is discovered without a merely-down backend
  being mistaken for one (amended 2026-07-28; see [ADR-003](ADR-003-first-class-sessions.md)).

Two properties of that design are **invariants, not incidental** — they are what keeps the
single-process registry replaceable in one place, and each is easy to break with a change that looks
harmless:

- **All fan-out goes through `SseManager.broadcast`.** Routers publish; only the stream generator in
  `routers/sse.py` reads a client queue. Nothing outside `sse/manager.py` may write to one. A
  "quick" direct queue write from a router would work perfectly on one worker and be invisible until
  the day there are two.
- **Resync is ordering-free.** A reconnect's mark is compared against the log's head to decide
  *whether* to resync; a resync is still "refetch everything" and never replays `activity_events`
  from that id. So delivery needs to be
  at-least-once and nothing more — a duplicated or reordered message costs a redundant refetch, not
  a divergence. Making reconnect replay from the event log instead would buy some bandwidth and
  spend that guarantee.

  **Redis pub/sub does not clear that bar** and was rejected for it (2026-08-06). It is at-most-once
  by Redis's own definition: a subscriber that blinks loses whatever was published meanwhile, and
  redis-py reconnects and resubscribes silently, so the loss has no symptom at either end. Measured:
  a killed subscriber received nothing published during the gap and raised nothing. A **stream**
  clears it — the reader resumes from the last id it saw.

## Consequences

- **Reuses the existing HTTP/cookie/proxy stack**: no separate WS auth or upgrade handling; the
  cookie session (ADR-002/ADR-003) authenticates the stream directly.
- **One connection, not one per resource**: multiplexing keeps the connection count at one per user
  and centralises reconnect logic — but it means the manager must route every event type and a
  single overflow policy governs all of them.
- **In-memory manager is single-process**: correct for the current single-worker deployment, and the
  one thing a second worker would break — a client attached to worker A is unreachable from worker
  B. Per-user affinity at the proxy does *not* defer it, because a shared dashboard fans out to
  other users, who land on other workers. Because of the two invariants above, the fix is a
  backplane behind `broadcast` needing only at-least-once delivery. **Redis** (amended 2026-08-04),
  superseding an earlier note here that `LISTEN/NOTIFY` would do: it would, on its own merits, but
  a second replica also needs a shared rate-limit store, and `limits` — the library under slowapi —
  offers memory, memcached, mongodb and redis/valkey, with no Postgres backend. Redis is therefore
  already required, and one backplane is cheaper to run and reason about than two. Both halves are
  **built**: the shared rate-limit store first (2026-08-06), because it could not lag the first
  replica without silently multiplying every abuse limit
  ([ADR-013](ADR-013-rate-limit-cf-connecting-ip.md)), then fan-out itself (2026-08-07), as a Redis
  stream read from the last id each worker saw.
- **The engine is Valkey** (amended 2026-08-19), because `redis:8-alpine` now bundles the former
  Redis Stack modules and loads five of them for an app that uses counters and one stream; the
  Valkey image loads only its own scripting engine, holding 9.2 MiB resident against 22.3 MiB with
  this stack's flags. Not a licensing decision: Redis 8's AGPLv3 asks nothing of a stock image run
  as a separate service. The swap needed no migration because nothing here is durable, and cost no
  rename because what `REDIS_URL`, redis-py and the compose service name is the protocol Valkey
  speaks.
- **The reader repairs what resumption cannot.** Entries trimmed while a worker was away, or lost to
  a store restart, leave a gap the stream cannot close. So on *recovery* — not on each failed retry,
  which would refetch every open tab every second for the length of the outage — the reader tells its
  local clients to resync. Publishing never raises: the write has already committed, so a store fault
  costs sibling replicas a frame rather than costing the caller their write.
- **Overflow favours resync over silence**: bounded queues can drop a slow client's backlog, but
  the overflow sentinel guarantees it *knows* frames were dropped and re-syncs, so it never
  silently diverges — and the stream itself survives, so one burst costs one refetch.
- **Client-side write ordering matters on the server**: because REST mutations and SSE fan-out are
  separate paths, event construction must be choreographed around the commit (ADR-015).
