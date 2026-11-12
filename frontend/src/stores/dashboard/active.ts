import {
  apiAddWidget,
  apiGetDashboard,
  apiRemoveWidget,
  apiUpdateLayout,
  apiUpdateWidget,
  type Dashboard,
  type DashboardWidget,
  type LayoutGesture,
  type LayoutItem,
} from '../../api/dashboards'
import { ApiError } from '../../api/http'
import { applyCreatedList } from '../../resources/listData'
import {
  beginDashboardRequest,
  dashboardLoadSatisfiesRequest,
  isLatestDashboardRequest,
  mergeDashboardLoadOptions,
  type NormalizedLoadDashboardOptions,
  normalizeDashboardLoadOptions,
  resetDashboardRequests,
} from '../../utils/dashboard/loadOptions'
import { useConnectionStore } from '../connection'
import { toast } from '../toast'
import {
  createSessionGuard,
  type DashboardGet,
  type DashboardSet,
  type DashboardState,
} from './state'

type InFlightDashboardLoad = {
  id: string
  options: NormalizedLoadDashboardOptions
  queuedOptions: NormalizedLoadDashboardOptions | null
  latestRequestSerial: number
  promise: Promise<void>
}

type PendingLayoutSave = {
  dashboardId: string
  layout: LayoutItem[]
  gesture?: LayoutGesture
  retried?: boolean
}

let inFlightDashboardLoad: InFlightDashboardLoad | null = null
// Layout saves are serialized: one PUT in flight at a time, plus at most one pending layout (the
// latest wins). Drag/resize would otherwise fire unsequenced saves that all send the same base
// version, so the second 409s against the user's own first save.
let layoutSaveInFlight = false
let pendingLayoutSave: PendingLayoutSave | null = null

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

type ActiveSlice = Pick<
  DashboardState,
  | 'dashboard'
  | 'loading'
  | 'loadError'
  | 'conflict'
  | 'loadDashboard'
  | 'saveLayout'
  | 'addWidget'
  | 'removeWidget'
  | 'updateWidget'
  | 'resolveConflict'
>

export function createActiveSlice(set: DashboardSet, get: DashboardGet): ActiveSlice {
  const sessionGuard = () => createSessionGuard(set)

  return {
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,

    async loadDashboard(id, options = {}) {
      const guard = sessionGuard()
      const requestedOptions = normalizeDashboardLoadOptions(options)

      // SSE keeps the held dashboard current while the stream is live (patches, background
      // refreshes, resync on recovery), so a foreground re-open has nothing to fetch. Claiming
      // the serial still invalidates any in-flight load for another dashboard.
      if (
        !requestedOptions.background &&
        inFlightDashboardLoad?.id !== id &&
        get().dashboard?.id === id &&
        !get().loadError &&
        !get().conflict &&
        useConnectionStore.getState().status === 'connected'
      ) {
        beginDashboardRequest(id)
        guard.set({ loading: false })
        return
      }

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
              const status = error instanceof ApiError ? error.status : null
              const shouldSurfaceBackgroundAccessLoss =
                !showLoading &&
                currentOptions.surfaceAccessLoss &&
                (status === 403 || status === 404)
              const isLatestRequest = isLatestDashboardRequest(id, currentLoad.latestRequestSerial)

              // 404/403 land here and the editor page reads loadError. A background SSE refresh
              // keeps the current dashboard visible unless the event is an access change and the
              // server confirms the dashboard is now forbidden or missing for this user.
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

    async saveLayout(layout, gesture) {
      const { dashboard } = get()
      if (!dashboard) return
      // Coalesce: keep only the newest requested layout.
      pendingLayoutSave = { dashboardId: dashboard.id, layout, gesture }
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
            const result = await apiUpdateLayout(
              current.id,
              pending.layout,
              current.version,
              pending.gesture,
            )
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
                // The replay is the same drag on a newer base, so it is still the widget they moved.
                gesture: pending.gesture,
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
        const { created_list: createdList, ...updated } = await apiAddWidget(dashboard.id, widget)
        guard.set({ dashboard: updated })
        if (createdList && guard.isCurrent()) applyCreatedList(createdList)
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
        const updated = await apiRemoveWidget(dashboard.id, widgetId)
        guard.set({ dashboard: updated })
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

    resolveConflict() {
      const { dashboard, loadDashboard } = get()
      set({ conflict: false })
      if (dashboard) void loadDashboard(dashboard.id)
    },
  }
}

export function resetActive(): void {
  inFlightDashboardLoad = null
  layoutSaveInFlight = false
  pendingLayoutSave = null
  resetDashboardRequests()
}
