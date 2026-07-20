# ADR-013: Rate Limiting Keyed on `CF-Connecting-IP`

**Date:** 2026-07-20

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
Cloudflare.

## Consequences

- **Per-client auth limits actually isolate**: each real client gets its own bucket instead of
  sharing the proxy's, so one abuser's attempts don't consume everyone's budget (and vice versa).
- **Trusting the header is safe *only* because of the tunnel topology**: this decision depends on the
  origin being unreachable except through Cloudflare. If the origin were ever exposed directly, the
  header would become spoofable and this keying would be unsafe.
- **Dev parity via fallback**: local development, with no Cloudflare, falls back to the peer address
  so the limiter still works without special-casing.
- **Buckets are in-memory/per-process**: correct for the current single worker; a multi-worker
  deployment needs a shared limiter store (tracked as #45 in CONTEXT.md).
