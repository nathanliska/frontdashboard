# ADR-005: Two-Layer Client State — Zustand Stores + Scoped-Query Caches

**Date:** 2026-07-20

## Context

The frontend holds two very different kinds of state:

- **App/session state** — the current user, the dashboards list, notifications, toast/confirm/UI —
  which is singular, long-lived, and read imperatively from many places.
- **Resource collections** — list items, calendar occurrences, agenda entries — which are
  *scoped* (per list, per date window), fetched on demand, and patched incrementally by SSE.

Forcing both into one Zustand store makes scoped, cache-keyed resource data awkward (manual
keying, manual invalidation) and bloats the store. Forcing both into a query-cache library loses the
ergonomic imperative access the app/session state wants.

## Decision

Use **two layers**:

1. **Zustand `stores/`** for app/session state (`auth`, `dashboards`, `notifications`, `toast`,
   `confirm`, `ui`).
2. **`resources/*` backed by `resources/scopedQuery.ts`** — a `useSyncExternalStore` cache keyed by
   scope — for lists, calendar occurrences, and agenda, via `useQuery` / `invalidateWhere` /
   `updateWhere`.

Convention: **don't put list/calendar data in a Zustand store**; use `createScopedQuery`. Read state
reactively with `useStore(selector)` inside components; use `useStore.getState()`/`setState()` in
store actions, resources, and utils. Cross-store reads/writes (e.g. dashboard store → `useAuthStore`)
are normal ([frontend/CLAUDE.md](../../frontend/CLAUDE.md)).

## Consequences

- **Each kind of state uses the tool that fits it**: singular imperative state in Zustand; scoped,
  invalidatable, SSE-patched collections in scoped queries.
- **A clear rule prevents drift**: "list/calendar data never goes in a store" keeps the two layers
  from bleeding together over time.
- **Two reset surfaces**: clearing state at an auth boundary must reach *both* layers — every Zustand
  store *and* every resource cache (`resetXData()`), or stale data leaks across accounts (ADR-012).
- **Two mental models for contributors**: a new engineer must learn both the store pattern and the
  scoped-query pattern. The payoff is that neither is contorted to do the other's job.
