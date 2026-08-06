# ADR-018: The Backend Schema Is the API Contract — Generated Types, Validated Boundaries

**Date:** 2026-07-25

## Context

The frontend re-declared the API by hand. Every response was cast (`res.json() as Dashboard`), so
a shape the backend no longer returned still type-checked and only failed deep inside a component;
DTOs were duplicated interfaces that drifted silently; widget config was `Record<string, unknown>`,
pushing `typeof x === 'string'` checks into render paths; and SSE event names were bare strings
duplicated in the router and in the backend's `EventType` enum. Nothing failed when the two sides
disagreed — the failure surfaced later, as wrong data or a stale UI.

The backend already had the information: FastAPI derives an OpenAPI document from the Pydantic
models it serializes with.

## Decision

**The backend's OpenAPI document is the single source of truth for API and event shapes**, and the
frontend consumes it mechanically:

- `make contracts` exports the schema (`python -m app.openapi_export`) and generates zod schemas
  into `frontend/src/api/generated/contract.ts` (typed-openapi). The file is committed; CI
  regenerates it and fails on any diff, so client and server cannot drift.
- **Every success-path response body is validated** at the network boundary via
  `parseJson(res, Schema)`. A body that doesn't match raises the ordinary `ApiError` the toast
  path already handles, instead of flowing into the app as a wrong shape.
- **Shapes are modelled, not stringly-typed**: widgets are a discriminated union keyed on
  `widget_type`, and SSE frames are validated against generated frame schemas whose `event_type`
  is the generated `EventType` enum.
- **Anything the frontend must react to has to exist in OpenAPI.** SSE frames aren't response
  bodies, so they're registered as models purely to appear in `components.schemas`; endpoints
  return typed models rather than bare dicts.

One deliberate seam remains, local and documented at its definition:

- The exporter widens single-value `const` to a one-member `enum`, because the generator emits
  `z.literal` for `enum` but degrades `const` to `z.string()` — without it the widget union
  doesn't narrow.

Seams are debt, not fixtures. The client also re-opened the `extra="allow"` SSE payload until the
generator learned to express it; that compensation is gone. Re-check on every generator upgrade.

## Consequences

- **Contract drift is a CI failure, not a runtime surprise.** A changed response shape fails the
  contract job or the type check; it can no longer reach a component as `any`-shaped data.
- **Exhaustiveness is enforceable.** SSE routing is a total `Record<EventType, …>` and widget
  rendering is an exhaustive `switch`, so a new backend event or widget type is a compile error in
  the places that must handle it — the failure mode this replaces was a silently stale UI.
- **The generator's limits become backend concerns.** Making a shape expressible in OpenAPI is now
  part of shipping it (see the `const`/`enum` seam), and swapping generators means re-checking
  those seams.
- **Type checking has to actually run.** Generated types are only a gate if `tsc` runs over the
  project — `vite build` is transpile-only, a solution-style root `tsconfig.json` makes plain
  `tsc --noEmit` silently check nothing, and the generator marks its own output `@ts-nocheck`
  unless `--no-runtime-types` keeps each type inferred from the schema beside it.
- **Boundary validation is strict by default.** A response missing a required field now errors
  visibly rather than rendering half-broken. Where the backend is genuinely permissive
  (open-ended SSE payloads), that has to be re-stated explicitly on the client schema.
- **An untyped server-side shape forces a hand-written client one.** `layout` was
  `list[dict[str, Any]]` on the backend, which forced a hand-authored item schema on the client;
  typing it server-side (#14, 2026-07-26) deleted that. The rule generalizes: when a client
  schema is hand-written, the fix is to type the shape in the backend, not to maintain the copy.

Related: [ADR-004](ADR-004-sse-over-websocket.md) (SSE transport),
[ADR-006](ADR-006-rest-fetch-sse-patch.md) (REST fetch + SSE patch — the flows this contract types).
