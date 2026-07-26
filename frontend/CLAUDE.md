# frontend/CLAUDE.md — conventions that bite

Stack-specific memory for the React/TypeScript frontend. Repo-wide rules live in the root
`CLAUDE.md`. Everything here is a convention an agent can't safely infer from one file.

## State: two layers, not one
- Zustand `stores/` hold app/session state (auth, dashboards, notifications, toast, confirm, ui).
  Lists, calendar occurrences, and agenda live in `resources/*` backed by
  `resources/scopedQuery.ts` (`useSyncExternalStore` cache keyed by scope). **Don't put
  list/calendar data in a Zustand store** — use `createScopedQuery` and its
  `useQuery`/`invalidateWhere`/`updateWhere`.
- Hook vs. `getState()` is intentional: `useStore(selector)` inside components for reactivity;
  `useStore.getState()`/`setState()` in store actions, resources, and utils. Cross-store reads
  and writes (e.g. dashboard store → `useAuthStore`) are normal here.

## Data flow: REST fetch + SSE incremental updates
- Every resource does an initial REST fetch; SSE events then mutate caches in place. A new
  entity type needs BOTH its event names added in `hooks/useSSE.ts` AND a
  `handleXResourceEvent` router in `resources/*` — forget either and the UI silently goes stale.
- **Echo suppression:** mutations send a `clientMutationId` and the SSE echo is skipped via
  `consumePending…MutationEcho`. On mutation error you must `forgetPending…Mutation(id)` or the
  bookkeeping leaks (see `stores/dashboard.ts`, `resources/listData.ts`).
- Any new resource cache needs a `resetXData()` wired into `stores/auth.ts` logout/failed-init,
  or stale data leaks across accounts.

## API contract: generated, never hand-written
- Request/response/SSE types come from `api/generated/contract.ts`, generated from the backend's
  OpenAPI document by `make contracts` (repo root) and committed. **Never hand-write a DTO and
  never edit the generated file** — change the Pydantic model, rerun `make contracts`. CI
  regenerates and fails on any diff (ADR-018).
- **Every success body is validated**: `return parseJson(res, Schema)`, not `res.json() as T`. A
  shape that doesn't match raises `ApiError` and surfaces as a toast.
- If the frontend must react to a shape, it has to be in OpenAPI — that includes SSE frames
  (registered as models in `app/schemas/sse.py` purely so they appear in `components.schemas`)
  and endpoints that would otherwise return a bare dict.
- `EVENT_ROUTES` in `hooks/useSSE.ts` is a total `Record<EventType, …>` and `WidgetRenderer`'s
  switch is exhaustive — a new backend event/widget type fails the type check there rather than
  silently never reaching a cache. **`npm run typecheck` is `tsc --build`**; plain `tsc --noEmit`
  checks nothing here (the root tsconfig is a solution file) and `vite build` is transpile-only.
- Two generator seams, both documented at their definitions: the exporter widens `const` to a
  one-member `enum` (else discriminators degrade to `z.string()`), and `SseEventSchema` re-opens
  `payload` (the backend model is `extra="allow"`; validation would otherwise strip keys).

## Network and errors
- `apiFetch` (`api/client.ts`) is the **only** network entry for `/api` — it sets the CSRF
  header, includes credentials, and does single-flight 401 refresh + retry (redirecting to
  `/login` on failure). Never call `fetch` directly.
- All API errors are `ApiError` via `api/http.ts` — `requestVoid(...)` for no-body responses,
  `readError(res, fallback)` elsewhere. **No hand-rolled `res.ok` checks** (review finding #4).
- Errors surface through the global `toast` store, not by throwing to components; use the
  imperative `toast.error/success/info` and `await confirm(msg)` from non-component code.

## Dashboards
- Layout saves are optimistic-version + 409: a conflict sets `conflict: true` (banner) rather
  than throwing; resolution reloads. After a successful save, widget object references are
  deliberately preserved to keep memoized widget subtrees valid — don't "simplify" that.
- `loadDashboard`/`loadSummaries` carry hand-rolled in-flight/serial/debounce machinery to
  coalesce SSE-triggered refetches; background loads pass `{ background: true }` and only
  surface access loss on real 403/404. Tread carefully.
- **Adding a widget type starts in the backend**: a `XWidgetConfig`/`XWidgetResponse`/`XWidgetCreate`
  trio in `app/schemas/dashboards.py` joined to the `WidgetResponse` and `WidgetCreate` unions plus
  a `WIDGET_CONFIG_MODELS` entry, then `make contracts`. On the
  client that lands as a new union member, and the type check then points at everything that must
  handle it: the `switch` in `components/dashboard/WidgetRenderer.tsx` and `WIDGET_LABELS` in
  `WidgetContainer.tsx`. Still manual: an entry in `widgets/AddWidgetTypeStep.tsx` (+ a picker step
  if it binds a resource) and resource fetching/SSE wiring. `WidgetType` is derived from the
  generated union — don't redeclare it.

## Tests (Vitest)
- Default test environment is **`node`, not jsdom** — DOM/component tests must opt in per-file
  with `// @vitest-environment jsdom`.
- No global fetch/MSW mock: tests mock `api/*` modules (`vi.hoisted` + `vi.mock`) and
  `stores/toast`. Reset resource/mutation caches between tests with the exported
  `__resetXForTests()` helpers.
