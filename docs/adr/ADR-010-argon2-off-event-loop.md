# ADR-010: Argon2 Password Hashing Off the Event Loop

**Date:** 2026-07-20

## Context

Argon2 is a deliberately expensive, memory-hard password hash — that cost is the security. But
FastAPI runs on a single-threaded async event loop, and a synchronous Argon2 call blocks that loop
for its whole duration. Under an auth burst (many simultaneous logins/registrations), synchronous
hashing would serialize on the loop and stall *every* request, and unbounded concurrent hashes would
each allocate Argon2's large memory cost at once, risking memory exhaustion.

## Decision

Run `hash_password` / `verify_password` **off the event loop** in a worker thread via
`anyio.to_thread.run_sync`, under a **shared, bounded capacity limiter**
(`argon2_max_concurrency`, default 4).

- The thread offload keeps the event loop responsive during hashing.
- The shared limiter caps how many Argon2 operations run concurrently, bounding peak memory and CPU
  regardless of how many auth requests arrive at once.

## Consequences

- **An auth burst can't stall the event loop**: hashing happens on worker threads, so unrelated
  requests keep flowing.
- **Peak memory is bounded**: the limiter caps concurrent Argon2 memory to `argon2_max_concurrency`
  operations' worth, trading a small amount of login latency under burst for a hard memory ceiling.
- **The limiter is a tunable capacity knob**: too low starves legitimate logins under load; too high
  reinvites memory pressure. The default (4) suits household scale; it's config, not code.
- **Correct pairing with enumeration-safety**: the constant-work login (ADR-011) always performs
  exactly one verify, so this offload+limiter governs a predictable per-login cost.
