/**
 * Dashboard store — the listing page's summaries and the editor's active dashboard.
 *
 * Both live here because they share the same data. Layout saves carry the version they loaded; a
 * 409 is rebased onto the server's layout and retried once, and only a second one sets `conflict`
 * for the UI to offer a reload. Actions never throw: errors go to the global toast store.
 */

import { create } from 'zustand'
import { apiUpdatePreferences } from '../api/auth'
import {
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiGetTrash,
  apiListDashboards,
  apiRemoveWidget,
  apiRestoreDashboard,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
  type Dashboard,
  type DashboardSummary,
  type DashboardWidget,
  type LayoutItem,
  type TrashedDashboard,
  type WidgetCreate,
} from '../api/dashboards'
import type { ShareCreate } from '../api/shares'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import {
  affectsTrash,
  applyLocalDashboardSummaryUpdate,
  canSkipDashboardSummaryReload,
  canSuppressLocalDashboardEcho,
  getEventDashboardId,
  isDashboardShareEvent,
  isLayoutOnlyDashboardEvent,
  isOwnDashboardEcho,
  patchWidgetConfig,
  sortDashboardSummaries,
} from '../utils/dashboard/dashboardEvents'
import {
  beginDashboardRequest,
  dashboardLoadSatisfiesRequest,
  isLatestDashboardRequest,
  type LoadDashboardOptions,
  mergeDashboardLoadOptions,
  type NormalizedLoadDashboardOptions,
  normalizeDashboardLoadOptions,
  resetDashboardRequests,
} from '../utils/dashboard/loadOptions'
import { createDebouncedRefresh } from '../utils/debounce'
import { useAuthStore } from './auth'
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'
import { toast } from './toast'

type InFlightDashboardLoad = {
  id: string
  options: NormalizedLoadDashboardOptions
  queuedOptions: NormalizedLoadDashboardOptions | null
  latestRequestSerial: number
  promise: Promise<void>
}

type InFlightSummariesLoad = {
  promise: Promise<void>
}

type PendingLayoutSave = { dashboardId: string; layout: LayoutItem[]; retried?: boolean }

let inFlightDashboardLoad: InFlightDashboardLoad | null = null
let inFlightSummariesLoad: InFlightSummariesLoad | null = null
// Layout saves are serialized: one PUT in flight at a time, plus at most one pending layout (the
// latest wins). Drag/resize would otherwise fire unsequenced saves that all send the same base
// version, so the second 409s against the user's own first save.
let layoutSaveInFlight = false
let pendingLayoutSave: PendingLayoutSave | null = null
let queuedSummariesForceReload = false
let inFlightTrashLoad: InFlightSummariesLoad | null = null
let queuedTrashForceReload = false

const DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS = 100

const summariesRefresh = createDebouncedRefresh(DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS)
// A widget drag emits one layout event per save; without this each costs every other tab a full
// dashboard GET.
const dashboardRefresh = createDebouncedRefresh(DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS)

const scheduleSummariesRefresh = (run: () => Promise<void>) => summariesRefresh.schedule(run)
const scheduleDashboardRefresh = (run: () => Promise<void>) => dashboardRefresh.schedule(run)

/**
 * Re-read the dashboard a conflicting save was based on, and replay this drag on top of it.
 *
 * A merge rather than a replacement: `PUT /layout` stores the array wholesale and never checks it
 * against the widget set, so posting our own stale array would strip the entry for a widget the
 * other editor just added. Their entries survive; ours win where both moved the same widget.
 * Returns null when the re-read fails, which falls back to the conflict banner.
 */
async function rebaseLayout(
  dashboardId: string,
  layout: LayoutItem[],
): Promise<{ layout: LayoutItem[]; version: number } | null> {
  let server: Dashboard
  try {
    server = await apiGetDashboard(dashboardId)
  } catch {
    return null
  }

  const ours = new Map(layout.map((item) => [item.i, item]))
  const merged = (server.layout ?? []).map((item: LayoutItem) => ours.get(item.i) ?? item)
  const known = new Set((server.layout ?? []).map((item: LayoutItem) => item.i))
  // Widgets the server knows nothing about are ours to add — the other editor cannot have
  // positioned them, and dropping them would lose the placement this drag just made.
  for (const item of layout) if (!known.has(item.i)) merged.push(item)

  return { layout: merged, version: server.version }
}

export interface DashboardState {
  // ── Listing ────────────────────────────────────────────────────────────────
  summaries: DashboardSummary[]
  summariesLoaded: boolean
  summariesLoading: boolean
  // Trash rides along with the listing: fetched once (loaded-flag cache), invalidated by this
  // client's delete/restore and by non-echo SSE deleted/restored events.
  trash: TrashedDashboard[]
  trashLoaded: boolean

  // ── Active editor ──────────────────────────────────────────────────────────
  dashboard: Dashboard | null
  loading: boolean
  loadError: boolean // true when loadDashboard fails (404, 403, network)
  conflict: boolean // true when a PUT /layout returns 409 (version mismatch)

  // ── Listing actions ────────────────────────────────────────────────────────
  loadSummaries: (force?: boolean) => Promise<void>
  createDashboard: (data: {
    name: string
    shares?: ShareCreate[]
  }) => Promise<DashboardSummary | null>
  deleteDashboard: (id: string) => Promise<boolean>
  toggleFavorite: (id: string, current: boolean) => Promise<boolean>
  renameDashboard: (id: string, name: string) => Promise<boolean>
  loadTrash: (force?: boolean) => Promise<void>
  restoreDashboard: (id: string) => Promise<DashboardSummary | null>

  // ── Editor actions ─────────────────────────────────────────────────────────
  loadDashboard: (id: string, options?: LoadDashboardOptions) => Promise<void>
  saveLayout: (layout: LayoutItem[]) => Promise<void>
  addWidget: (widget: WidgetCreate) => Promise<boolean>
  removeWidget: (widgetId: string) => Promise<boolean>
  updateWidget: (widgetId: string, config: Record<string, unknown>) => Promise<boolean>
  handleDashboardEvent: (event: ResourceEvent) => Promise<void>
  handleContentEvent: (event: SseEvent) => void
  resolveConflict: () => void
}

export const useDashboardStore = create<DashboardState>()((set, get) => {
  function sessionGuard() {
    const gen = currentSessionGeneration()
    return {
      isCurrent: () => gen === currentSessionGeneration(),
      set: ((...args: Parameters<typeof set>) => {
        if (gen === currentSessionGeneration()) set(...args)
      }) as typeof set,
    }
  }

  return {
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,
    trash: [],
    trashLoaded: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,

    // ── Listing ────────────────────────────────────────────────────────────────

    async loadSummaries(force = false) {
      const guard = sessionGuard()
      const { summariesLoaded, summariesLoading } = get()
      if (!force && summariesLoaded && !summariesLoading) return
      if (inFlightSummariesLoad) {
        if (force) queuedSummariesForceReload = true
        return inFlightSummariesLoad.promise
      }

      set({ summariesLoading: true })
      const currentLoad: InFlightSummariesLoad = { promise: Promise.resolve() }
      inFlightSummariesLoad = currentLoad
      currentLoad.promise = (async () => {
        try {
          while (true) {
            queuedSummariesForceReload = false

            try {
              const nextSummaries = await apiListDashboards()
              guard.set({ summaries: nextSummaries, summariesLoaded: true })
            } catch {
              if (!queuedSummariesForceReload) {
                toast.error('Failed to load dashboards.')
                break
              }
              continue
            }

            if (!queuedSummariesForceReload) break
          }
        } finally {
          guard.set({ summariesLoading: false })
          if (inFlightSummariesLoad === currentLoad) inFlightSummariesLoad = null
        }
      })()

      return currentLoad.promise
    },

    async createDashboard(data) {
      const guard = sessionGuard()
      try {
        const summary = await apiCreateDashboard(data)
        guard.set((s) => ({ summaries: [summary, ...s.summaries] }))
        return summary
      } catch {
        toast.error('Failed to create dashboard.')
        return null
      }
    },

    async deleteDashboard(id) {
      const guard = sessionGuard()
      try {
        await apiDeleteDashboard(id)
        guard.set((s) => ({ summaries: s.summaries.filter((d) => d.id !== id) }))
        // The row moved to the trash; the DELETE response carries no trash entry (purge_at), so
        // refresh the cache it just invalidated.
        if (guard.isCurrent() && get().trashLoaded) void get().loadTrash(true)
        return true
      } catch {
        toast.error('Failed to delete dashboard.')
        return false
      }
    },

    async loadTrash(force = false) {
      const guard = sessionGuard()
      if (!force && get().trashLoaded) return
      if (inFlightTrashLoad) {
        if (force) queuedTrashForceReload = true
        return inFlightTrashLoad.promise
      }

      const currentLoad: InFlightSummariesLoad = { promise: Promise.resolve() }
      inFlightTrashLoad = currentLoad
      currentLoad.promise = (async () => {
        try {
          do {
            queuedTrashForceReload = false
            try {
              const trash = await apiGetTrash()
              guard.set({ trash, trashLoaded: true })
            } catch {
              // Best-effort: the trash section simply doesn't render if this fails — the primary
              // listing must not couple to it. Left un-loaded so the next visit retries.
              break
            }
          } while (queuedTrashForceReload)
        } finally {
          if (inFlightTrashLoad === currentLoad) inFlightTrashLoad = null
        }
      })()

      return currentLoad.promise
    },

    async restoreDashboard(id) {
      const guard = sessionGuard()
      try {
        const summary = await apiRestoreDashboard(id)
        // The response is the restored summary, so both caches update locally — the SSE echo
        // (changed_fields ["restored"]) is suppressed instead of triggering a reload.
        guard.set((s) => ({
          trash: s.trash.filter((t) => t.id !== id),
          summaries: sortDashboardSummaries([summary, ...s.summaries.filter((d) => d.id !== id)]),
        }))
        return summary
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to restore dashboard.')
        return null
      }
    },

    async toggleFavorite(id, current) {
      const guard = sessionGuard()
      try {
        const authState = useAuthStore.getState()
        const currentFavoriteIds = authState.user?.preferences?.favorite_dashboard_ids ?? []
        const nextFavoriteIds = current
          ? currentFavoriteIds.filter((favoriteId) => favoriteId !== id)
          : [...currentFavoriteIds.filter((favoriteId) => favoriteId !== id), id]

        const updatedUser = await apiUpdatePreferences({ favorite_dashboard_ids: nextFavoriteIds })
        if (!guard.isCurrent()) return false // boundary crossed mid-request — drop both writes
        useAuthStore.setState({ user: updatedUser })
        guard.set((s) => ({
          summaries: s.summaries.map((d) => (d.id === id ? { ...d, is_favorite: !current } : d)),
          dashboard:
            s.dashboard?.id === id ? { ...s.dashboard, is_favorite: !current } : s.dashboard,
        }))
        return true
      } catch {
        toast.error('Failed to update favorite.')
        return false
      }
    },

    async renameDashboard(id, name) {
      const guard = sessionGuard()
      try {
        const updated = await apiUpdateDashboardMeta(id, { name })
        guard.set((s) => ({
          summaries: sortDashboardSummaries(s.summaries.map((d) => (d.id === id ? updated : d))),
          dashboard:
            s.dashboard?.id === id
              ? {
                  ...s.dashboard,
                  name: updated.name,
                  version: updated.version,
                }
              : s.dashboard,
        }))
        return true
      } catch {
        toast.error('Failed to rename dashboard.')
        return false
      }
    },

    // ── Editor ─────────────────────────────────────────────────────────────────

    async loadDashboard(id, options = {}) {
      const guard = sessionGuard()
      const requestedOptions = normalizeDashboardLoadOptions(options)

      const requestSerial = beginDashboardRequest(id)

      if (inFlightDashboardLoad?.id === id) {
        inFlightDashboardLoad.latestRequestSerial = requestSerial
        const shouldQueueFollowUp =
          requestedOptions.background ||
          !dashboardLoadSatisfiesRequest(inFlightDashboardLoad.options, requestedOptions)

        if (shouldQueueFollowUp) {
          inFlightDashboardLoad.queuedOptions = mergeDashboardLoadOptions(
            inFlightDashboardLoad.queuedOptions,
            requestedOptions,
          )
        }

        return inFlightDashboardLoad.promise
      }

      const currentLoad: InFlightDashboardLoad = {
        id,
        options: requestedOptions,
        queuedOptions: null,
        latestRequestSerial: requestSerial,
        promise: Promise.resolve(),
      }
      const promise = (async () => {
        try {
          let nextOptions: NormalizedLoadDashboardOptions | null = requestedOptions

          while (nextOptions) {
            const currentOptions = nextOptions
            currentLoad.options = currentOptions
            currentLoad.queuedOptions = null

            const showLoading = !currentOptions.background

            if (showLoading) {
              guard.set({ loading: true, loadError: false })
            }

            try {
              const dashboard = await apiGetDashboard(id)
              if (!isLatestDashboardRequest(id, currentLoad.latestRequestSerial)) {
                nextOptions = currentLoad.queuedOptions
                continue
              }
              guard.set({
                dashboard,
                conflict: false,
                loadError: false,
                ...(showLoading ? { loading: false } : {}),
              })
            } catch (error) {
              const status =
                typeof (error as { status?: unknown }).status === 'number'
                  ? (error as { status: number }).status
                  : null
              const shouldSurfaceBackgroundAccessLoss =
                !showLoading &&
                currentOptions.surfaceAccessLoss &&
                (status === 403 || status === 404)
              const isLatestRequest = isLatestDashboardRequest(id, currentLoad.latestRequestSerial)

              // 404/403 land here — editor page reads loadError to show an error state.
              // For background SSE refreshes, keep the current dashboard visible unless
              // the event explicitly represents an access change and the server confirms
              // the dashboard is now forbidden or missing for this user.
              if (isLatestRequest && (showLoading || shouldSurfaceBackgroundAccessLoss)) {
                guard.set({
                  dashboard: shouldSurfaceBackgroundAccessLoss ? null : get().dashboard,
                  loadError: true,
                  loading: false,
                  conflict: false,
                })
              }
            } finally {
              if (showLoading && isLatestDashboardRequest(id, currentLoad.latestRequestSerial)) {
                guard.set({ loading: false })
              }
            }

            nextOptions = currentLoad.queuedOptions
          }
        } finally {
          if (inFlightDashboardLoad === currentLoad) {
            inFlightDashboardLoad = null
          }
        }
      })()

      currentLoad.promise = promise
      inFlightDashboardLoad = currentLoad
      return promise
    },

    async saveLayout(layout) {
      const { dashboard } = get()
      if (!dashboard) return
      // Coalesce: keep only the newest requested layout.
      pendingLayoutSave = { dashboardId: dashboard.id, layout }
      // Serialize: a drain is already running and will pick the entry above up, with whatever
      // version the in-flight save returns.
      if (layoutSaveInFlight) return

      layoutSaveInFlight = true
      const guard = sessionGuard()
      try {
        while (pendingLayoutSave) {
          if (!guard.isCurrent()) return
          const pending: PendingLayoutSave = pendingLayoutSave
          pendingLayoutSave = null

          const current = get().dashboard
          // Re-read the dashboard each pass: the previous save bumped its version, and the user
          // may have navigated to a different dashboard entirely.
          if (!current || current.id !== pending.dashboardId) continue
          try {
            const result = await apiUpdateLayout(current.id, pending.layout, current.version)
            if (!guard.isCurrent()) {
              return
            }
            if (result.conflict) {
              if (pending.retried) {
                // Beaten twice by a live co-editor. Stop rather than fight them for the grid.
                pendingLayoutSave = null
                guard.set({ conflict: true })
                return
              }

              const merged = await rebaseLayout(current.id, pending.layout)
              if (!guard.isCurrent()) return
              if (!merged) {
                pendingLayoutSave = null
                guard.set({ conflict: true })
                return
              }
              guard.set((s) => ({
                dashboard: s.dashboard ? { ...s.dashboard, version: merged.version } : s.dashboard,
              }))
              // A drag that landed while the PUT was open already supersedes this one, and starts
              // with its own retry budget.
              pendingLayoutSave ??= {
                dashboardId: pending.dashboardId,
                layout: merged.layout,
                retried: true,
              }
              continue
            }
            guard.set((s) => ({
              dashboard: {
                ...result.dashboard,
                // Layout saves don't touch widget data. Preserve existing widget
                // references so memoized widget subtrees aren't invalidated on drag/resize.
                widgets: s.dashboard?.widgets ?? result.dashboard.widgets,
              },
              conflict: false,
            }))
          } catch {
            pendingLayoutSave = null
            toast.error('Failed to save layout.')
            return
          }
        }
      } finally {
        // Only release ownership if this drain still belongs to the current session. A drain
        // superseded by an auth boundary (whose flag resetDashboardData already cleared) must not
        // clobber a newer session's drain flag, or two drains could run concurrently and self-409.
        if (guard.isCurrent()) layoutSaveInFlight = false
      }
    },

    async addWidget(widget) {
      const guard = sessionGuard()
      const { dashboard } = get()
      if (!dashboard) return false
      try {
        const updated = await apiAddWidget(dashboard.id, widget)
        guard.set({ dashboard: updated })
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to add widget.')
        return false
      }
    },

    async removeWidget(widgetId) {
      const guard = sessionGuard()
      const { dashboard } = get()
      if (!dashboard) return false
      try {
        await apiRemoveWidget(dashboard.id, widgetId)
        // Optimistic: remove from local state without a full refetch
        guard.set((s) => {
          if (!s.dashboard) return s
          return {
            dashboard: {
              ...s.dashboard,
              widgets: s.dashboard.widgets.filter((w: DashboardWidget) => w.id !== widgetId),
              layout: s.dashboard.layout.filter((l: LayoutItem) => l.i !== widgetId),
              version: s.dashboard.version + 1,
            },
          }
        })
        return true
      } catch {
        toast.error('Failed to remove widget.')
        return false
      }
    },

    async updateWidget(widgetId, config) {
      const guard = sessionGuard()
      const { dashboard } = get()
      if (!dashboard) return false
      try {
        const updated = await apiUpdateWidget(dashboard.id, widgetId, config)
        guard.set((s) => {
          if (!s.dashboard) return s
          return {
            dashboard: {
              ...s.dashboard,
              widgets: s.dashboard.widgets.map((w: DashboardWidget) =>
                w.id === widgetId ? updated : w,
              ),
            },
          }
        })
        return true
      } catch {
        toast.error('Failed to update widget.')
        return false
      }
    },

    async handleDashboardEvent(event) {
      // A resync means "you may have missed anything": no entity to scope to, no echo to
      // suppress, and access may have been revoked while we were disconnected — so reload
      // both levels immediately (no debounce) and let access loss surface.
      if (event.event_type === 'resync') {
        const { summaries, summariesLoaded, summariesLoading, trashLoaded, dashboard } = get()
        const activeId = dashboard?.id ?? null
        await Promise.all([
          summariesLoaded || summariesLoading || summaries.length > 0
            ? get().loadSummaries(true)
            : null,
          trashLoaded ? get().loadTrash(true) : null,
          activeId
            ? get().loadDashboard(activeId, { background: true, surfaceAccessLoss: true })
            : null,
        ])
        return
      }

      const activeDashboard = get().dashboard
      const activeDashboardId = activeDashboard?.id ?? null
      const eventDashboardId = getEventDashboardId(event)
      const isLayoutOnlyEvent = isLayoutOnlyDashboardEvent(event)
      const shouldSkipSummaryReload = canSkipDashboardSummaryReload(event)
      const shouldSurfaceAccessLoss = isDashboardShareEvent(event)
      const hasLocalMutationEcho = isOwnDashboardEcho(event)
      const shouldSuppressLocalMutationReload =
        hasLocalMutationEcho && canSuppressLocalDashboardEcho(event)

      // Trash membership changed somewhere this client didn't see (own mutations update the
      // cache from their responses and suppress the echo, so this only fires for other sessions).
      if (affectsTrash(event) && !shouldSuppressLocalMutationReload && get().trashLoaded) {
        void get().loadTrash(true)
      }

      const { summaries, summariesLoaded, summariesLoading } = get()
      let summariesRefreshPromise: Promise<void> | null = null
      if (summariesLoaded || summariesLoading || summaries.length > 0) {
        if (shouldSkipSummaryReload) {
          set((state) => {
            const nextSummaries = applyLocalDashboardSummaryUpdate(state.summaries, event)
            return nextSummaries === state.summaries ? state : { summaries: nextSummaries }
          })
        } else if (!shouldSuppressLocalMutationReload) {
          summariesRefreshPromise = scheduleSummariesRefresh(() => get().loadSummaries(true))
        }
      }

      if (activeDashboardId && eventDashboardId === activeDashboardId) {
        if (event.event_type === 'dashboard.deleted' && eventDashboardId === activeDashboardId) {
          set({ dashboard: null, loadError: true, loading: false, conflict: false })
          return
        }

        if (shouldSuppressLocalMutationReload) {
          await summariesRefreshPromise
          return
        }

        if (
          isLayoutOnlyEvent &&
          activeDashboard?.id === eventDashboardId &&
          activeDashboard.version >= event.entity_version
        ) {
          await summariesRefreshPromise
          return
        }

        // Read and write in the same tick: the patch is built against this snapshot, so an await
        // in between would let it overwrite a dashboard someone else's frame had since replaced.
        const patched = patchWidgetConfig(get().dashboard, event)
        if (patched) {
          set({ dashboard: patched })
          await summariesRefreshPromise
          return
        }

        await Promise.all([
          summariesRefreshPromise,
          scheduleDashboardRefresh(() =>
            get().loadDashboard(activeDashboardId, {
              background: true,
              surfaceAccessLoss: shouldSurfaceAccessLoss,
            }),
          ),
        ])
        return
      }

      await summariesRefreshPromise
    },

    handleContentEvent(event) {
      const activeDashboardId = get().dashboard?.id
      const eventDashboardId = getEventDashboardId(event)
      if (!activeDashboardId || eventDashboardId !== activeDashboardId) return

      set((state) => {
        if (!state.dashboard) return state

        if (event.event_type === 'list.deleted') {
          const nextWidgets = state.dashboard.widgets.filter(
            (widget) =>
              !(widget.resource_type === 'list' && widget.resource_id === event.entity_id),
          )
          const removedWidgetIds = new Set(
            state.dashboard.widgets
              .filter(
                (widget) =>
                  widget.resource_type === 'list' && widget.resource_id === event.entity_id,
              )
              .map((widget) => widget.id),
          )

          return {
            dashboard: {
              ...state.dashboard,
              widgets: nextWidgets,
              layout: state.dashboard.layout.filter((item) => !removedWidgetIds.has(item.i)),
              version:
                removedWidgetIds.size > 0 ? state.dashboard.version + 1 : state.dashboard.version,
            },
          }
        }

        return state
      })
    },

    resolveConflict() {
      const { dashboard, loadDashboard } = get()
      set({ conflict: false })
      if (dashboard) void loadDashboard(dashboard.id)
    },
  }
})

export function resetDashboardData(): void {
  bumpSessionGeneration()
  summariesRefresh.cancel()
  dashboardRefresh.cancel()
  inFlightDashboardLoad = null
  inFlightSummariesLoad = null
  inFlightTrashLoad = null
  queuedTrashForceReload = false
  layoutSaveInFlight = false
  pendingLayoutSave = null
  queuedSummariesForceReload = false
  resetDashboardRequests()
  useDashboardStore.setState({
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,
    trash: [],
    trashLoaded: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,
  })
}
