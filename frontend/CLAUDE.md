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
- **The echo check consumes — so ask once, at the router, and pass the verdict down.** One SSE
  frame fans out to several handlers (`onListEvent` feeds the list cache, the agenda and the
  dashboard store), and whichever one calls `consumePending…MutationEcho` first is the only one
  ever told the truth. That is exactly how the agenda kept refetching after every checkbox click
  while the list cache correctly ignored the same event. New handler on a fanned-out event → take
  `{ isOwnEcho }` as a parameter; don't call the check yourself.
- **Suppressing an echo obliges you to patch what it would have refreshed.** The agenda's
  reminders only updated *because* of that refetch, so silencing it without teaching the mutation
  path to re-derive them would have left a checked reminder on screen. Both halves are pinned by
  tests in `resources/agendaData.test.tsx`; removing either one fails.
- **A mutation's response is the truth — apply it, never refetch it.** Every mutating endpoint
  returns the updated resource; patch caches/state from that response and let echo suppression
  absorb the SSE. A GET right after your own successful POST/PATCH/DELETE is a bug (this is how
  the invite/trash/share double-requests happened). The only sanctioned refetches: 409 divergence
  (client state provably stale → `invalidateWhere`), server-derived data the client can't compute
  (calendar occurrence expansion), and someone *else's* change arriving via a non-echo SSE event.
- Mount-effect fetches with no store/cache above them (settings-modal shares, invite lists) must
  be single-flighted in `api/*` — StrictMode double-invokes effects in dev and the double GET is
  visible in the network tab. Anything fetched on a *page* belongs in a store with a loaded-flag
  cache instead (see `loadTrash`).
- Any new resource cache needs a `resetXData()` wired into `stores/auth.ts` logout/failed-init,
  or stale data leaks across accounts.
- `createScopedQuery` caches the 32 most recently fetched scopes (`maxCachedScopes`) and evicts
  the coldest beyond that. Entries with a **mounted subscriber** or an **in-flight request** are
  never evicted — the first would hand React a fresh empty entry mid-render, the second would
  resolve into a map the entry has left. Note that eviction does not notify listeners, so a
  component cannot observe it; assert on `getState` in tests, not on rendered output.
- **Snapshot a `Map`/`Set` before iterating it if the loop body can mutate it** —
  `for (const entry of [...m.values()])`. A JS iterator visits entries inserted *during* iteration,
  so anything that re-inserts (LRU `touch`, a listener that resubscribes) hands the loop the same
  entry again and it never ends. It spins synchronously, so no `testTimeout` fires and no stack
  identifies it — the process just exhausts its heap.

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

## UI primitives (#27 — use these, don't hand-roll)
- **Modals go through `ui/Dialog`** (Radix): it owns the focus trap, labelling, Escape, scroll
  lock, and focus restoration. Render conditionally (`{open && <Dialog …>}`); `onEscape` is for
  stepped modals that back out before closing (AddWidget). Never build a raw
  `role="dialog"` overlay — the hand-rolled ones never trapped focus.
- **`confirm(message, { confirmLabel, tone })`** — the button must say what it does ("Remove",
  "Move to trash"); defaults are `Delete`/`danger`. Cancel is first in the DOM on
  purpose: Enter on open cancels, it never destroys.
- **Row/card actions use `ui/OverflowMenu`** (Radix DropdownMenu, visible ≥44px trigger) or, for
  inline icon rows, must reveal on `group-focus-within` as well as hover — hover-only doesn't
  exist for touch or keyboard.
- **Form validation goes through `ui/FormField`** (or, in an inline editor, the same
  `aria-invalid` + `aria-describedby` + `role="alert"` wiring done locally) — never a toast. A
  toast is announced without saying which field it belongs to and disappears on a timer; validate
  where the input is so the message can point at it. Validate *in* the editor component, not in
  the page handler above it, or there is nothing to attach the message to.
- The toaster is a **persistent `role="status"` live region** — do not conditionally mount it;
  a live region that mounts with its first message announces nothing.
- **`ui/ErrorBoundary` wraps every widget and the app root** — a render throw must never reach
  React's default, which unmounts the whole tree and leaves a blank page. It matters here because
  dashboards render user-authored content, so a crash tends to be *deterministic*: reloading hits
  the same data and throws again. Widget-level is the useful one (one bad tile costs its tile, not
  the page) and is keyed by widget id so a reused grid slot resets. It is a class component
  because `getDerivedStateFromError` has no hook equivalent — don't "modernise" it. Tests assert a
  *sibling survives* the crash; neutering the boundary fails them.
- In tests, Radix menus open on `fireEvent.pointerDown(trigger)`, not `click`.

## Network and errors
- `apiFetch` (`api/client.ts`) is the **only** network entry for `/api` — it sets the CSRF
  header and includes credentials. Never call `fetch` directly.
- **Renaming a cookie does not remove the old one**, so any client-side read must name the new
  cookie *first* rather than treat the prefix as optional. Production sets `__Host-csrf_token`;
  browsers from before that rename still hold `csrf_token`, and a single regex with an optional
  `(?:__Host-)?` returns whichever the browser happened to list first — the stale one. That shipped
  on 2026-07-28 and 403'd every mutation with "CSRF token invalid", **logout included**, so the app
  offered no way out of it (the store swallows logout errors, so it merely *looked* like it
  worked). Cookie order is the browser's choice: assert both orderings, and have the server clear
  superseded names on every cookie write so they don't linger for the cookie's full max-age.
- **Only `401` means logged out.** Not `403` (that is the permission layer answering "editor
  access required"), and never a `5xx`, timeout or network rejection — reading those as a lost
  session is what signed users out during deploys before ADR-003's amendment. A 401 calls the
  handler `stores/auth` registers via `setSessionExpiredHandler`, which flips the store so
  `RequireAuth` navigates; transient failures retry once with jitter, then surface to the caller.
- Retries are **GET-only**, and the reason is echo suppression rather than idempotency: a retried
  mutation emits a second SSE frame whose `client_mutation_id` was already consumed by the first,
  so the client would read its own write as someone else's change.
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
- **Anything a module schedules must be cancellable, and cancelled in `test/setup.ts`.** A worker
  is reused across files, so a `setTimeout` a test armed and never cleared keeps its closure —
  and the store behind it — alive for the rest of the run. The toast store's auto-dismiss is the
  worked example: it keeps its handles in a `Map` purely so `__resetToastStoreForTests` can clear
  them from the global `afterEach`. Store a handle you can clear, not a fire-and-forget timer.
- Running the suite with `NODE_OPTIONS=--max-old-space-size=1024` is worth it while touching
  cache or timer code: a runaway loop then OOMs its own worker in seconds instead of taking the
  machine down with it.
