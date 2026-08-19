# FDR-008: Real-Time Delivery (SSE)

**Status:** Active
**Last reviewed:** 2026-08-16

## Overview

The live-update backbone. A single Server-Sent Events connection per user carries every kind of
change — list edits, calendar changes, dashboard shares, notifications — so that a change made
anywhere (a phone, another household member, another tab) appears on every open view, including
always-on wall displays. This FDR covers the connection's own behavior; how individual features use
it is in their FDRs.

## Behavior

- **One connection per user.** A single `EventSource('/api/sse')` multiplexes all event types.
- **Priming and resync.** The stream opens with a `connected` event carrying the activity log's
  current high-water mark. The client remembers that mark, advances it past every activity frame
  and any head-stamped resync, and hands it back on reconnect; the server resyncs only if the log
  has moved past it.
- **A resync says what changed.** When one is needed, the frame names the kinds of thing that
  changed on dashboards the client can see, so it refetches only those caches rather than all of
  them. An unknown or absent scope widens back to refetching everything.
- **Overflow doesn't go silent.** A client whose queue overflows keeps its stream: the backlog is
  replaced by one resync frame delivered in place, and frames arriving before it goes out are
  dropped as covered by the refetch it orders. A burst therefore costs one coalesced refetch, not
  a reconnect per overflow.
- **A worker's own clients see its writes even when the fan-out is broken.** Frames are delivered
  locally first and published to the other workers after, and publishing never fails a write that
  has already committed. When a worker's reader reaches the stream again it resyncs its own clients
  once — repairing whatever it missed, whether the stream was trimmed past its mark or a publish was
  simply lost.
- **Robust reconnect.** A network drop uses the browser's built-in retry (resyncing via the header). A
  stream rejected with an HTTP error — which `EventSource` never retries — reconnects on jittered
  exponential backoff (1s → 30s cap, indefinitely) and never signs anyone out. Every fourth attempt
  checks `/auth/me`, so a genuinely ended session is noticed while a merely-unreachable server is
  not mistaken for one.
- **Revocation ends the stream.** Streams revalidate their session every 30s and end when it's
  revoked; revocation also drops in-process streams immediately.
- **The UI admits when the stream is down.** An amber dot appears in the sidebar while reconnecting
  and nothing is drawn otherwise. A tab brought back to the foreground reopens a stream the browser
  closed while it was hidden.
- **Own echoes are recognized by a per-tab id.** Every mutation carries the tab's per-load
  `X-Client-Id`, the frame's payload echoes it back as `origin_client_id`, and the issuing tab
  skips invalidating what its own response already applied — everyone else's tabs, the same user's
  included, still act on the frame. The frame itself always arrives: it advances the reconnect mark
  and feeds the activity feed, so suppression gates only the cache work. The accepted trade: if a
  write commits but its response is lost, that tab stays stale until the error is retried or the
  next foreign event or resync. A per-mutation registry cannot close that window either — the echo
  outruns the failed response — and it costs bookkeeping at every call site, so the constant wins.
- **A held cache is trusted while the stream is live.** Re-opening a dashboard the store already
  holds fetches nothing while the connection is `connected` — the same cached-and-not-stale rule
  the scoped resource caches apply. A degraded stream, a load error, or an unresolved conflict
  still fetches, and background (event- and resync-driven) reloads always do. The trade: the
  §5 out-of-order-commit hole is no longer papered over by mount refetches — for any cache.

## Design Decisions

### 1. SSE, not WebSocket; one multiplexed connection

**Decision:** Use SSE over plain HTTP, one connection per user carrying all event types, with an
in-memory manager and bounded per-client queues.
**Why:** The data flow is server→client only; SSE reuses the existing cookie auth and reverse proxy
and has built-in reconnection, with none of WebSocket's unused duplex or extra handshake. See ADR-004.
**Tradeoff:** The in-memory manager is still process-local — it knows only its own worker's clients —
so a Valkey stream carries each frame to the others. Proxy-level affinity would not have substituted,
since a shared dashboard fans out to users on *other* workers. Two invariants kept that a swap rather
than a rewrite, and both are stated in ADR-004 because a change breaking either looks harmless on one
worker: fan-out has a single choke point, and resync is ordering-free.

### 2. Overflow coalesces into an in-place resync

**Decision:** An overflowing client's backlog is dropped and replaced with a single resync frame on
the same stream, stamped with the log's head so the client's mark moves with the refetch it orders;
until that frame is delivered, further frames for that client are dropped too.
**Why:** A slow client that just kept its connection would silently miss events and diverge forever;
the resync guarantees it knows it fell behind. Ending the stream instead was rejected: a still-slow
client reconnects into the same burst that overflowed it and loops through disconnect/refetch
cycles, each costing a full refetch of every cache. See ADR-004.
**Tradeoff:** The resync is unscoped — nothing tracked what the dropped backlog held — so the
refetch covers every cache. The stamp is best-effort: read on its own short-lived session, and an
unreadable head costs one redundant scoped resync at the next reconnect rather than the stream.
A slow consumer still gets a refetch rather than backpressure.

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

### 7. A resync names what changed, so the client refetches only that

**Decision:** When a reconnect does need a resync, the frame carries `scopes` — the distinct
`entity_type`s logged since the client's mark, on dashboards it can currently see. The client maps
those to resource handlers and refetches only those. Absent `scopes`, or a scope this build does
not recognise, means refetch everything.

**Why:** A resync is the expensive path — six requests on a dashboard — and it fires exactly when
something genuinely changed. Naming the kind of change turns "refetch everything you hold" into
"refetch lists". It costs one bounded scan the reconnect was already making, and needs neither
event bodies nor commit-ordered ids, which is what made replay expensive.

Unlike the head comparison, this **is** audience-filtered: "something happened somewhere" reveals
nothing, but "a calendar event changed" would report another household's activity. Filtering uses
`list_accessible_dashboard_ids`, so a dashboard shared and then revoked stops being named.

**Tradeoff:** The scan is capped (500 events); past it the honest answer is "unknown", which means
a full resync — the same answer as before this existed. Unknown scopes widen rather than narrow, so
a backend that learns to log a new entity type cannot silently skip a cache in an older client.
Notifications stay unconditional: they are not activity events, so no scope can rule them out.

### 8. Degraded connection is shown, and only while degraded

**Decision:** A `connection` store tracks `connecting | connected | reconnecting`, and the sidebar
draws an amber dot only in `reconnecting`. `onerror` sets that state *before* the `CLOSED` check, so
a drop the browser retries for us still counts as degraded.

**Why:** The failure this exists for is the app looking live while receiving nothing — a wall display
or a phone that quietly stopped listening. A dot that is green all day stops being read, so only the
state worth acting on is drawn.

**Tradeoff:** Deliberately not a presence badge: it reports *your* stream, not who else is online, so
it cannot answer "is anyone there". A tab that is degraded for less than a render never shows it,
which is intended.

### 9. A foregrounded tab reopens a stream the browser abandoned

**Decision:** On `visibilitychange` to visible, reconnect if `readyState` is `CLOSED`. A reconnect
already scheduled by `onerror` is left alone, since two would open two streams.

**Why:** A backgrounded tab can have its stream closed without `EventSource` retrying, so the tab
returns looking live while receiving nothing — the same silent-staleness failure as an overflow,
reached by a different route. `readyState` is the only signal available: SSE pings are comment lines
the client never sees as events, so nothing else distinguishes a dead stream from an idle one.

**Tradeoff:** It fires on foreground only, so a tab left visible on a machine that slept still waits
for the backoff. One connection per open tab is unchanged — this reopens a stream, it does not add one.

### 10. `changed_fields` is a closed vocabulary with one refetch table

**Decision:** A `dashboard.updated` frame says what changed in `payload["changed_fields"]`, drawn
from the `ChangedField` enum. The enum reaches the frontend as a generated Zod enum, and every
consumer derives its answer from one table in `utils/dashboard/changedFields.ts` rather than
testing the strings itself. Two facts decide every question:

| Value | Applied locally | Moves the dashboard row | Emitted by |
|---|---|---|---|
| `layout` | yes | yes — bumps `version` | `PUT /layout`, widget add/delete |
| `widgets` | yes | **no** — writes the widget row only | widget add/update/delete |
| `name` | no | yes | `PATCH /dashboards/{id}` |
| `restored` | no | yes | `POST /restore` |
| `shares` | no | no | `dashboard.share_*` frames only |

*Applied locally* means the client can compute the new summary itself, so the frame needs no
`GET /dashboards`. *Moves the dashboard row* means `updated_at` advanced, so a cached summary is
stale until touched. `widgets` alone is the one combination where the first is true and the second
is false, and missing that is a summary list silently sorted wrong.

**Why:** These were five predicates in the store and two in the activity feed, each individually
correct and none of them showing which combinations were possible. Extending the vocabulary meant
re-deriving all seven by hand, and a mistake surfaces only as staleness in *another* person's tab —
the class of bug nobody reports. Typing the vocabulary makes a consumer testing for a value no
producer emits a compile error, and `test_changed_fields_coverage.py` makes the reverse a build
failure.

**Tradeoff:** Order is deliberately not part of the contract. Rows already in the activity log carry
`['widgets', 'layout']` unsorted and are immutable, so sortedness could never become an invariant —
consumers must stay order-independent, which the table's tests pin. An unrecognised value fails
safe in every direction (refetch, don't suppress), so a newer backend cannot talk an older tab out
of refreshing.

## Access

Every stream authenticates via the user's session (ADR-002/ADR-003); a user receives only events for
resources they own or that are shared with them (broadcast audience = owner ∪ share principals,
ADR-015).

## Related

- **ADRs:** ADR-004 (SSE over WebSocket), ADR-006 (REST fetch + SSE patch), ADR-015 (SSE write
  choreography), ADR-003 (first-class sessions)
- **FDRs:** FDR-005 (Lists), FDR-006 (Calendar & Events), FDR-007 (Notifications & Activity)
