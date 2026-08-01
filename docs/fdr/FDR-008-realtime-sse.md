# FDR-008: Real-Time Delivery (SSE)

**Status:** Active
**Last reviewed:** 2026-07-31

## Overview

The live-update backbone. A single Server-Sent Events connection per user carries every kind of
change — list edits, calendar changes, dashboard shares, notifications — so that a change made
anywhere (a phone, another household member, another tab) appears on every open view, including
always-on wall displays. This FDR covers the connection's own behavior; how individual features use
it is in their FDRs.

## Behavior

- **One connection per user.** A single `EventSource('/api/sse')` multiplexes all event types.
- **Priming and resync.** The stream opens with a `connected` event carrying the activity log's
  current high-water mark. The client remembers that mark, advances it past every activity frame,
  and hands it back on reconnect; the server resyncs only if the log has moved past it.
- **Overflow doesn't go silent.** A client whose queue overflows is disconnected with a closed
  sentinel, so it reconnects and resyncs rather than staying connected but deaf.
- **Robust reconnect.** A network drop uses the browser's built-in retry (resyncing via the header). A
  stream rejected with an HTTP error — which `EventSource` never retries — reconnects on jittered
  exponential backoff (1s → 30s cap, indefinitely) and never signs anyone out. Every fourth attempt
  checks `/auth/me`, so a genuinely ended session is noticed while a merely-unreachable server is
  not mistaken for one.
- **Revocation ends the stream.** Streams revalidate their session every 30s and end when it's
  revoked; revocation also drops in-process streams immediately.

## Design Decisions

### 1. SSE, not WebSocket; one multiplexed connection

**Decision:** Use SSE over plain HTTP, one connection per user carrying all event types, with an
in-memory manager and bounded per-client queues.
**Why:** The data flow is server→client only; SSE reuses the existing cookie auth and reverse proxy
and has built-in reconnection, with none of WebSocket's unused duplex or extra handshake. See ADR-004.
**Tradeoff:** The in-memory manager is single-process (correct for the current single worker); a
multi-worker deployment needs a shared backplane, and proxy-level affinity would not substitute for
one, since a shared dashboard fans out to users on other workers. Two invariants keep that swap
confined to `broadcast` — single choke point, ordering-free resync — and both are stated in ADR-004
because a change that breaks either would look harmless on one worker.

### 2. Overflow evicts with a resync sentinel

**Decision:** An overflowing client is evicted with a closed sentinel so its stream ends in a resync
and reconnect.
**Why:** A slow client that just kept its connection would silently miss events and diverge forever;
forcing a resync guarantees it knows it fell behind. See ADR-004.
**Tradeoff:** A slow consumer gets a full resync rather than backpressure.

### 3. HTTP-error reconnect just reconnects, and periodically asks whether the session is alive

**Decision:** A `CLOSED`/HTTP-error stream (never auto-retried by `EventSource`) reconnects on
jittered exponential backoff, probing `/auth/me` every fourth attempt; a fresh `EventSource` (no
`Last-Event-ID`) requests the resync itself. The browser's own network-drop retry is left alone.
**Why:** This path used to refresh the session first and redirect to `/login` if that failed — which
meant a backend restart or a proxy 502 signed people out mid-session. A rejected stream says the
server is unhappy, not that the session is gone. The periodic probe is what still catches a real
logout, since without a refresh call there is nothing else whose failure would reveal one. Amended
2026-07-28; see ADR-003.
**Tradeoff:** A signed-out tab keeps reconnecting until the next probe lands, rather than being
ejected at once. Jitter is required or every tab retries in lockstep after a restart.

### 4. Revocation is enforced by a periodic check, dropped immediately as an optimization

**Decision:** Streams revalidate the session every 30s and end on revocation; an immediate in-process
drop is a latency optimization layered on top.
**Why:** The periodic check is worker-agnostic and holds even without the immediate drop, so
revocation is guaranteed within 30s regardless of process topology. See ADR-003. Closes issue #8's
authorization half.
**Tradeoff:** Up to a 30s window before a revoked session's stream closes if the immediate drop
doesn't apply (e.g. a different worker).

### 5. A reconnect proves it missed nothing rather than assuming it did

**Decision:** `connected` carries `last_event_id` — `max(activity_events.event_id)`. The client
tracks that mark across the session and passes it as `?last_event_id=` when reconnecting; the server
sends `resync` only when the head has moved past it. A client with no mark still resyncs itself, so
the pessimistic path is intact.

**Why:** A resync costs a refetch of every cache the tab holds — six requests each on a dashboard —
and reconnects are common: every deploy, every network blip, every laptop wake. Because all writes
go through the backend, a restart produces no events at all, so the mark provably rules out a gap
and the reconnect costs nothing. The probe is deliberately unfiltered by audience: "nothing happened
to anyone" already proves nothing was missed, it resolves to a single index scan, and it discloses
no other user's activity. The query parameter carries the mark because the client reconnects by
opening a *fresh* `EventSource`, which sends no `Last-Event-ID` header; the header is still honoured
as a fallback.

**Tradeoff:** `event_id` comes from a sequence read at flush, before the transaction commits, so it
orders assignments rather than commits. An event assigned a lower id but committed after the
client's last-seen event, while that client was disconnected, sits below the mark and is not
replayed — the tab stays stale for that one event until its next resync. Today's unconditional
resync has no such hole. Closing it means ordering the stream id by commit, which is the
prerequisite for replaying event bodies rather than merely detecting a gap.

### 6. Streams are recycled on a jittered lifetime cap

**Decision:** A stream closes itself after ~30 minutes plus up to 10% jitter, ending with no
`resync` frame so the client reconnects and its mark decides what it missed.

**Why:** A connection severed without a close handshake is never reported as disconnected — the
proxy holds the upstream open, so the server's writes keep succeeding and sse-starlette's 25s ping
never errors. Such a stream stayed registered indefinitely, counted among the open clients and
enqueued to by every broadcast. Recycling bounds that to one lifetime. The cap is affordable only
because of §5: a reconnect that missed nothing costs one index probe instead of a refetch of every
cache, so deliberately forcing reconnects stopped being expensive.

**Tradeoff:** Every client reconnects roughly twice an hour whether it needs to or not. Jitter
keeps them from expiring in lockstep, which would rebuild the herd the cap exists to prevent.

## Access

Every stream authenticates via the user's session (ADR-002/ADR-003); a user receives only events for
resources they own or that are shared with them (broadcast audience = owner ∪ share principals,
ADR-015).

## Related

- **ADRs:** ADR-004 (SSE over WebSocket), ADR-006 (REST fetch + SSE patch), ADR-015 (SSE write
  choreography), ADR-003 (first-class sessions)
- **FDRs:** FDR-005 (Lists), FDR-006 (Calendar & Events), FDR-007 (Notifications & Activity)
