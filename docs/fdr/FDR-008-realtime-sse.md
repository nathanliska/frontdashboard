# FDR-008: Real-Time Delivery (SSE)

**Status:** Active
**Last reviewed:** 2026-07-20

## Overview

The live-update backbone. A single Server-Sent Events connection per user carries every kind of
change — list edits, calendar changes, dashboard shares, notifications — so that a change made
anywhere (a phone, another household member, another tab) appears on every open view, including
always-on wall displays. This FDR covers the connection's own behavior; how individual features use
it is in their FDRs.

## Behavior

- **One connection per user.** A single `EventSource('/api/sse')` multiplexes all event types.
- **Priming and resync.** The stream opens with a `connected` event; on reconnect it asks for a
  `resync` using `Last-Event-ID` so the client catches up on what it missed.
- **Overflow doesn't go silent.** A client whose queue overflows is disconnected with a closed
  sentinel, so it reconnects and resyncs rather than staying connected but deaf.
- **Robust reconnect.** A network drop uses the browser's built-in retry (resyncing via the header). A
  stream rejected with an HTTP error — which `EventSource` never retries — refreshes the session and
  reconnects on exponential backoff (1s → 30s cap, indefinitely), redirecting to `/login` only if the
  refresh itself fails.
- **Revocation ends the stream.** Streams revalidate their session every 30s and end when it's
  revoked; revocation also drops in-process streams immediately.

## Design Decisions

### 1. SSE, not WebSocket; one multiplexed connection

**Decision:** Use SSE over plain HTTP, one connection per user carrying all event types, with an
in-memory manager and bounded per-client queues.
**Why:** The data flow is server→client only; SSE reuses the existing cookie auth and reverse proxy
and has built-in reconnection, with none of WebSocket's unused duplex or extra handshake. See ADR-004.
**Tradeoff:** The in-memory manager is single-process (correct for the current single worker); a
multi-worker deployment needs a shared backplane.

### 2. Overflow evicts with a resync sentinel

**Decision:** An overflowing client is evicted with a closed sentinel so its stream ends in a resync
and reconnect.
**Why:** A slow client that just kept its connection would silently miss events and diverge forever;
forcing a resync guarantees it knows it fell behind. See ADR-004.
**Tradeoff:** A slow consumer gets a full resync rather than backpressure.

### 3. HTTP-error reconnect refreshes the session first

**Decision:** A `CLOSED`/HTTP-error stream (never auto-retried by `EventSource`) refreshes the session
and reconnects on exponential backoff; a fresh `EventSource` (no `Last-Event-ID`) requests the resync
itself. The browser's own network-drop retry is left alone.
**Why:** An HTTP-status rejection usually means an auth problem a refresh can fix; distinguishing it
from a plain network drop avoids both a redirect-to-login on a transient blip and a hot reconnect
loop. See ADR-004.
**Tradeoff:** Two reconnect paths (browser-native for drops, app-managed for HTTP errors) to keep
straight.

### 4. Revocation is enforced by a periodic check, dropped immediately as an optimization

**Decision:** Streams revalidate the session every 30s and end on revocation; an immediate in-process
drop is a latency optimization layered on top.
**Why:** The periodic check is worker-agnostic and holds even without the immediate drop, so
revocation is guaranteed within 30s regardless of process topology. See ADR-003. Closes issue #8's
authorization half.
**Tradeoff:** Up to a 30s window before a revoked session's stream closes if the immediate drop
doesn't apply (e.g. a different worker).

## Access

Every stream authenticates via the user's session (ADR-002/ADR-003); a user receives only events for
resources they own or that are shared with them (broadcast audience = owner ∪ share principals,
ADR-015).

## Related

- **ADRs:** ADR-004 (SSE over WebSocket), ADR-006 (REST fetch + SSE patch), ADR-015 (SSE write
  choreography), ADR-003 (first-class sessions)
- **FDRs:** FDR-005 (Lists), FDR-006 (Calendar & Events), FDR-007 (Notifications & Activity)
