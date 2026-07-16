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
- **Adding a widget type touches at least:** `WidgetType` in
  `utils/dashboard/widgetCreationTypes.ts`, a `case` in
  `components/dashboard/WidgetRenderer.tsx`, an entry in `widgets/AddWidgetTypeStep.tsx`
  (+ a picker step if it binds a resource), plus resource fetching/SSE wiring.

## Tests (Vitest)
- Default test environment is **`node`, not jsdom** — DOM/component tests must opt in per-file
  with `// @vitest-environment jsdom`.
- No global fetch/MSW mock: tests mock `api/*` modules (`vi.hoisted` + `vi.mock`) and
  `stores/toast`. Reset resource/mutation caches between tests with the exported
  `__resetXForTests()` helpers.
