# ADR-004: SSE (Not WebSocket), One Multiplexed Connection Per User

**Date:** 2026-07-20

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
- A client whose queue overflows is **evicted with a closed sentinel** so its stream ends and it
  reconnects with a resync — rather than staying connected and silently deaf.
- An HTTP-error-rejected stream (which `EventSource` never auto-retries) refreshes the session and
  reconnects on exponential backoff (1s → 30s cap), redirecting to `/login` only if the refresh
  itself fails.

## Consequences

- **Reuses the existing HTTP/cookie/proxy stack**: no separate WS auth or upgrade handling; the
  cookie session (ADR-002/ADR-003) authenticates the stream directly.
- **One connection, not one per resource**: multiplexing keeps the connection count at one per user
  and centralises reconnect logic — but it means the manager must route every event type and a
  single overflow policy governs all of them.
- **In-memory manager is single-process**: correct for the current single-worker deployment; a
  multi-worker or multi-instance deployment needs a shared backplane (tracked as future work).
- **Overflow favours resync over silence**: bounded queues can drop a slow client, but the eviction
  sentinel guarantees it *knows* it was dropped and re-syncs, so it never silently diverges.
- **Client-side write ordering matters on the server**: because REST mutations and SSE fan-out are
  separate paths, event construction must be choreographed around the commit (ADR-015).
