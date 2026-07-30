# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for FrontDashboard. ADRs document
significant, cross-cutting architectural decisions along with the context that motivated them and
the consequences they carry. They record *why* the architecture is the way it is — the rationale
and the rejected alternatives — not what the code does today (that's [CONTEXT.md](../../CONTEXT.md))
or what a feature does (that's the [FDRs](../fdr/INDEX.md)).

For more about ADRs, see [Michael Nygard's article](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## When to write one

Write an ADR when a decision is **cross-cutting** and **hard to reverse** — a storage model, an
auth mechanism, a real-time transport, a client state architecture. A choice local to one feature
belongs in that feature's FDR. The step-by-step record of *how a change was executed* is not a doc —
it's the git history (commit messages + diffs). ADRs answer *why we decided*, FDRs answer *what the
feature does*, [CONTEXT.md](../../CONTEXT.md) is the current-state snapshot, and
[docs/TODO.md](../TODO.md) is the open backlog.

## Decisions

| # | Decision | Date |
|---|----------|------|
| [ADR-001](ADR-001-per-resource-sharing.md) | Per-resource `ResourceShare` sharing (groups removed) | 2026-07-20 |
| [ADR-002](ADR-002-jwt-httponly-cookies-csrf.md) | Credential in HttpOnly cookies (`__Host-`) + Origin check + CSRF double-submit | 2026-07-20 |
| [ADR-003](ADR-003-first-class-sessions.md) | First-class sessions with immediate revocation | 2026-07-20 |
| [ADR-004](ADR-004-sse-over-websocket.md) | SSE (not WebSocket), one multiplexed connection per user | 2026-07-20 |
| [ADR-005](ADR-005-two-layer-client-state.md) | Two-layer client state — Zustand stores + scoped-query caches | 2026-07-20 |
| [ADR-006](ADR-006-rest-fetch-sse-patch.md) | REST for initial fetch, SSE for incremental patch | 2026-07-20 |
| [ADR-007](ADR-007-soft-delete-boundary.md) | Soft delete for lists/items/events; dashboards trash then purge | 2026-07-26 |
| [ADR-008](ADR-008-layout-version-occ.md) | Layout version integer for optimistic concurrency control | 2026-07-20 |
| [ADR-009](ADR-009-canonical-layout-mobile-projection.md) | Persisted layout is canonical, mobile view is a derived projection | 2026-07-20 |
| [ADR-010](ADR-010-argon2-off-event-loop.md) | Argon2 password hashing off the event loop | 2026-07-20 |
| [ADR-011](ADR-011-enumeration-safe-login.md) | Enumeration-safe, constant-work authentication (login + registration) | 2026-07-25 |
| [ADR-012](ADR-012-session-generation-guard.md) | Session-generation guard for auth-boundary state reset | 2026-07-20 |
| [ADR-013](ADR-013-rate-limit-cf-connecting-ip.md) | Rate limiting — per-route limits keyed on `CF-Connecting-IP` | 2026-07-30 |
| [ADR-014](ADR-014-fail-fast-prod-config.md) | Fail-fast production configuration validation | 2026-07-20 |
| [ADR-015](ADR-015-sse-write-choreography.md) | SSE write choreography — build before commit, broadcast after | 2026-07-20 |
| [ADR-016](ADR-016-hand-authored-migrations.md) | Hand-authored Alembic migrations, StrEnum-as-String, schema-via-upgrade | 2026-07-20 |
| [ADR-017](ADR-017-google-calendar-two-way-sync.md) | Google Calendar two-way sync (per-user OAuth) — *design, not yet implemented* | 2026-07-25 |
| [ADR-018](ADR-018-generated-validated-contracts.md) | Backend schema is the API contract — generated types, validated boundaries | 2026-07-25 |
| [ADR-019](ADR-019-static-asset-serving-contract.md) | Static asset serving contract — honest 404s and a revalidated shell | 2026-07-30 |
