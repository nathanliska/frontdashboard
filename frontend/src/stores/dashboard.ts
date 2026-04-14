/**
 * Dashboard store — manages both the listing page and the active editor.
 *
 * Two logical concerns live here because they share the same data:
 *  • Summaries (DashboardSummary[]) — lightweight cards shown on the /dashboards listing page.
 *    Each summary has id/name/is_favorite and share-related metadata but no widgets or layout.
 *  • Active dashboard (Dashboard | null) — the full record loaded when opening /dashboard/:id.
 *    Includes layout (react-grid-layout items) and widgets array.
 *
 * Layout saves use version-based conflict detection: the client sends the version it loaded,
 * the server rejects with 409 if another save happened in between. The `conflict` flag surfaces
 * this to the UI so the user can reload.
 *
 * Errors are surfaced via the global toast store rather than local component state, keeping
 * components lean — they just call store actions and trust errors will be announced.
 */

import { create } from 'zustand'
import { apiUpdatePreferences } from '../api/auth'
import type { ShareCreate } from '../api/shares'
import type { SseEvent } from '../hooks/useSSE'
import { useAuthStore } from './auth'
import { toast } from './toast'
import {
  consumePendingDashboardMutation,
  createClientMutationId,
  forgetPendingDashboardMutation,
  recordPendingDashboardMutation,
} from '../utils/dashboard/dashboardMutation'
import {
  type Dashboard,
  type DashboardSummary,
  type DashboardWidget,
  type LayoutItem,
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiListDashboards,
  apiRemoveWidget,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
} from '../api/dashboards'

type LoadDashboardOptions = {
  background?: boolean
  surfaceAccessLoss?: boolean
}

type NormalizedLoadDashboardOptions = {
  background: boolean
  surfaceAccessLoss: boolean
}

type InFlightDashboardLoad = {
  id: string
  options: NormalizedLoadDashboardOptions
  queuedOptions: NormalizedLoadDashboardOptions | null
  latestRequestSerial: number
  promise: Promise<void>
}

let inFlightDashboardLoad: InFlightDashboardLoad | null = null
let inFlightSummariesLoad: Promise<void> | null = null
let queuedSummariesForceReload = false
let latestDashboardRequest: { id: string; serial: number } | null = null
let scheduledSummariesRefreshTimer: ReturnType<typeof setTimeout> | null = null
let scheduledSummariesRefreshPromise: Promise<void> | null = null
let resolveScheduledSummariesRefresh: (() => void) | null = null
let rejectScheduledSummariesRefresh: ((error: unknown) => void) | null = null

const DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS = 100

function scheduleSummariesRefresh(run: () => Promise<void>): Promise<void> {
  if (!scheduledSummariesRefreshPromise) {
    scheduledSummariesRefreshPromise = new Promise<void>((resolve, reject) => {
      resolveScheduledSummariesRefresh = resolve
      rejectScheduledSummariesRefresh = reject
    })
  }

  if (scheduledSummariesRefreshTimer) {
    clearTimeout(scheduledSummariesRefreshTimer)
  }

  scheduledSummariesRefreshTimer = setTimeout(() => {
    scheduledSummariesRefreshTimer = null

    const resolve = resolveScheduledSummariesRefresh
    const reject = rejectScheduledSummariesRefresh

    scheduledSummariesRefreshPromise = null
    resolveScheduledSummariesRefresh = null
    rejectScheduledSummariesRefresh = null

    void run().then(
      () => resolve?.(),
      (error) => reject?.(error),
    )
  }, DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS)

  return scheduledSummariesRefreshPromise
}

function getEventPayload(event: SseEvent): Record<string, unknown> | undefined {
  return event.payload && typeof event.payload === 'object' ? event.payload : undefined
}

function getEventDashboardId(event: SseEvent): string | null {
  if (event.entity_type === 'dashboard') {
    return event.entity_id
  }

  const payload = getEventPayload(event)
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
}

function getDashboardEventChangedFields(event: SseEvent): string[] {
  const payload = getEventPayload(event)
  if (!Array.isArray(payload?.changed_fields)) return []
  return payload.changed_fields.filter((value): value is string => typeof value === 'string')
}

function isDashboardShareEvent(event: SseEvent): boolean {
  return (
    event.event_type === 'dashboard.share_added' ||
    event.event_type === 'dashboard.share_updated' ||
    event.event_type === 'dashboard.share_removed'
  )
}

function getDashboardEventClientMutationId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.client_mutation_id === 'string' ? payload.client_mutation_id : null
}

function isLayoutOnlyDashboardEvent(event: SseEvent): boolean {
  const changedFields = getDashboardEventChangedFields(event)
  return (
    event.event_type === 'dashboard.updated' &&
    changedFields.length === 1 &&
    changedFields[0] === 'layout'
  )
}

function canSkipDashboardSummaryReload(event: SseEvent): boolean {
  const changedFields = getDashboardEventChangedFields(event)
  return (
    event.event_type === 'dashboard.updated' &&
    changedFields.length > 0 &&
    changedFields.every((field) => field === 'layout' || field === 'widgets')
  )
}

function shouldApplyLocalDashboardSummaryTouch(event: SseEvent): boolean {
  const changedFields = getDashboardEventChangedFields(event)
  return (
    event.event_type === 'dashboard.updated' &&
    changedFields.includes('layout') &&
    changedFields.every((field) => field === 'layout' || field === 'widgets')
  )
}

function sortDashboardSummaries(summaries: DashboardSummary[]): DashboardSummary[] {
  return [...summaries].sort((a, b) => {
    if (a.is_favorite !== b.is_favorite) return Number(b.is_favorite) - Number(a.is_favorite)
    return b.updated_at.localeCompare(a.updated_at)
  })
}

function applyLocalDashboardSummaryUpdate(
  summaries: DashboardSummary[],
  event: SseEvent,
): DashboardSummary[] {
  if (!shouldApplyLocalDashboardSummaryTouch(event)) return summaries

  const dashboardId = getEventDashboardId(event)
  if (!dashboardId) return summaries

  let didChange = false
  const nextSummaries = summaries.map((summary) => {
    if (summary.id !== dashboardId) return summary
    const nextVersion =
      event.entity_version > summary.version ? event.entity_version : summary.version
    if (summary.version === nextVersion && summary.updated_at === event.created_at) {
      return summary
    }
    didChange = true
    return {
      ...summary,
      version: nextVersion,
      updated_at: event.created_at,
    }
  })

  return didChange ? sortDashboardSummaries(nextSummaries) : summaries
}

function consumePendingDashboardMutationEcho(event: SseEvent): boolean {
  const currentUserId = useAuthStore.getState().user?.id
  const clientMutationId = getDashboardEventClientMutationId(event)
  if (!currentUserId || event.actor_id !== currentUserId || !clientMutationId) {
    return false
  }

  return consumePendingDashboardMutation(clientMutationId)
}

function canSuppressLocalDashboardEcho(event: SseEvent): boolean {
  if (event.event_type === 'dashboard.created' || event.event_type === 'dashboard.deleted') {
    return true
  }

  if (event.event_type !== 'dashboard.updated') return false

  const changedFields = getDashboardEventChangedFields(event)
  return (
    changedFields.length > 0 &&
    changedFields.every((field) => field === 'name' || field === 'layout' || field === 'widgets')
  )
}

function normalizeDashboardLoadOptions(
  options: LoadDashboardOptions = {},
): NormalizedLoadDashboardOptions {
  return {
    background: options.background ?? false,
    surfaceAccessLoss: options.surfaceAccessLoss ?? false,
  }
}

function mergeDashboardLoadOptions(
  current: NormalizedLoadDashboardOptions | null,
  next: NormalizedLoadDashboardOptions,
): NormalizedLoadDashboardOptions {
  if (!current) return next
  return {
    background: current.background && next.background,
    surfaceAccessLoss: current.surfaceAccessLoss || next.surfaceAccessLoss,
  }
}

function dashboardLoadSatisfiesRequest(
  current: NormalizedLoadDashboardOptions,
  requested: NormalizedLoadDashboardOptions,
): boolean {
  return (
    (requested.background || !current.background) &&
    (!requested.surfaceAccessLoss || current.surfaceAccessLoss)
  )
}

function beginDashboardRequest(id: string): number {
  const serial = (latestDashboardRequest?.serial ?? 0) + 1
  latestDashboardRequest = { id, serial }
  return serial
}

function isLatestDashboardRequest(id: string, serial: number): boolean {
  return latestDashboardRequest?.id === id && latestDashboardRequest.serial === serial
}

interface DashboardState {
  // ── Listing ────────────────────────────────────────────────────────────────
  summaries: DashboardSummary[]
  summariesLoaded: boolean
  summariesLoading: boolean

  // ── Active editor ──────────────────────────────────────────────────────────
  dashboard: Dashboard | null
  loading: boolean
  loadError: boolean // true when loadDashboard fails (404, 403, network)
  conflict: boolean // true when a PUT /layout returns 409 (version mismatch)

  // ── Listing actions ────────────────────────────────────────────────────────
  loadSummaries: (force?: boolean) => Promise<void>
  createDashboard: (data: { name: string; shares?: ShareCreate[] }) => Promise<DashboardSummary>
  deleteDashboard: (id: string) => Promise<void>
  toggleFavorite: (id: string, current: boolean) => Promise<void>
  renameDashboard: (id: string, name: string) => Promise<void>

  // ── Editor actions ─────────────────────────────────────────────────────────
  loadDashboard: (id: string, options?: LoadDashboardOptions) => Promise<void>
  saveLayout: (layout: LayoutItem[]) => Promise<void>
  addWidget: (widget: {
    widget_type: string
    config?: Record<string, unknown>
    resource_type?: string | null
    resource_id?: string | null
  }) => Promise<void>
  removeWidget: (widgetId: string) => Promise<void>
  updateWidget: (widgetId: string, config: Record<string, unknown>) => Promise<void>
  handleDashboardEvent: (event: SseEvent) => Promise<void>
  handleContentEvent: (event: SseEvent) => void
  resolveConflict: () => void
}

export const useDashboardStore = create<DashboardState>()((set, get) => ({
  summaries: [],
  summariesLoaded: false,
  summariesLoading: false,
  dashboard: null,
  loading: false,
  loadError: false,
  conflict: false,

  // ── Listing ────────────────────────────────────────────────────────────────

  async loadSummaries(force = false) {
    const { summariesLoaded, summariesLoading } = get()
    if (!force && summariesLoaded && !summariesLoading) return
    if (inFlightSummariesLoad) {
      if (force) queuedSummariesForceReload = true
      return inFlightSummariesLoad
    }

    set({ summariesLoading: true })
    const promise = (async () => {
      try {
        while (true) {
          queuedSummariesForceReload = false

          try {
            const nextSummaries = await apiListDashboards()
            set({ summaries: nextSummaries, summariesLoaded: true })
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
        set({ summariesLoading: false })
        inFlightSummariesLoad = null
      }
    })()

    inFlightSummariesLoad = promise
    return promise
  },

  async createDashboard(data) {
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      const summary = await apiCreateDashboard(data, { clientMutationId })
      set((s) => ({ summaries: [summary, ...s.summaries] }))
      return summary
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to create dashboard.')
      throw new Error('create failed')
    }
  },

  async deleteDashboard(id) {
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      await apiDeleteDashboard(id, { clientMutationId })
      set((s) => ({ summaries: s.summaries.filter((d) => d.id !== id) }))
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to delete dashboard.')
    }
  },

  async toggleFavorite(id, current) {
    try {
      const authState = useAuthStore.getState()
      const currentFavoriteIds = authState.user?.preferences.favorite_dashboard_ids ?? []
      const nextFavoriteIds = current
        ? currentFavoriteIds.filter((favoriteId) => favoriteId !== id)
        : [...currentFavoriteIds.filter((favoriteId) => favoriteId !== id), id]

      const updatedUser = await apiUpdatePreferences({ favorite_dashboard_ids: nextFavoriteIds })
      useAuthStore.setState({ user: updatedUser })
      set((s) => ({
        summaries: s.summaries.map((d) => (d.id === id ? { ...d, is_favorite: !current } : d)),
        dashboard: s.dashboard?.id === id ? { ...s.dashboard, is_favorite: !current } : s.dashboard,
      }))
    } catch {
      toast.error('Failed to update favorite.')
    }
  },

  async renameDashboard(id, name) {
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      const updated = await apiUpdateDashboardMeta(id, { name }, { clientMutationId })
      set((s) => ({
        summaries: s.summaries.map((d) => (d.id === id ? updated : d)),
        dashboard:
          s.dashboard?.id === id
            ? { ...s.dashboard, name: updated.name, version: updated.version }
            : s.dashboard,
      }))
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to rename dashboard.')
    }
  },

  // ── Editor ─────────────────────────────────────────────────────────────────

  async loadDashboard(id, options = {}) {
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
            set({ loading: true, loadError: false })
          }

          try {
            const dashboard = await apiGetDashboard(id)
            if (!isLatestDashboardRequest(id, currentLoad.latestRequestSerial)) {
              nextOptions = currentLoad.queuedOptions
              continue
            }
            set({
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
              !showLoading && currentOptions.surfaceAccessLoss && (status === 403 || status === 404)
            const isLatestRequest = isLatestDashboardRequest(id, currentLoad.latestRequestSerial)

            // 404/403 land here — editor page reads loadError to show an error state.
            // For background SSE refreshes, keep the current dashboard visible unless
            // the event explicitly represents an access change and the server confirms
            // the dashboard is now forbidden or missing for this user.
            if (isLatestRequest && (showLoading || shouldSurfaceBackgroundAccessLoss)) {
              set({
                dashboard: shouldSurfaceBackgroundAccessLoss ? null : get().dashboard,
                loadError: true,
                loading: false,
                conflict: false,
              })
            }
          } finally {
            if (showLoading && isLatestDashboardRequest(id, currentLoad.latestRequestSerial)) {
              set({ loading: false })
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
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      const result = await apiUpdateLayout(dashboard.id, layout, dashboard.version, {
        clientMutationId,
      })
      if (result.conflict) {
        // Another editor saved a layout change between our load and this PUT.
        // Surface the conflict banner; user resolves by reloading.
        forgetPendingDashboardMutation(clientMutationId)
        set({ conflict: true })
        return
      }
      set((s) => ({
        dashboard: {
          ...result.dashboard,
          // Layout saves don't touch widget data. Preserve existing widget
          // references so memoized widget subtrees aren't invalidated on drag/resize.
          widgets: s.dashboard?.widgets ?? result.dashboard.widgets,
        },
        conflict: false,
      }))
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to save layout.')
    }
  },

  async addWidget(widget) {
    const { dashboard } = get()
    if (!dashboard) return
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      const updated = await apiAddWidget(dashboard.id, widget, { clientMutationId })
      set({ dashboard: updated })
    } catch (err) {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error(err instanceof Error ? err.message : 'Failed to add widget.')
    }
  },

  async removeWidget(widgetId) {
    const { dashboard } = get()
    if (!dashboard) return
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      await apiRemoveWidget(dashboard.id, widgetId, { clientMutationId })
      // Optimistic: remove from local state without a full refetch
      set((s) => {
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
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to remove widget.')
    }
  },

  async updateWidget(widgetId, config) {
    const { dashboard } = get()
    if (!dashboard) return
    const clientMutationId = createClientMutationId()
    recordPendingDashboardMutation(clientMutationId)
    try {
      const updated = await apiUpdateWidget(dashboard.id, widgetId, config, { clientMutationId })
      set((s) => {
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
    } catch {
      forgetPendingDashboardMutation(clientMutationId)
      toast.error('Failed to update widget.')
    }
  },

  async handleDashboardEvent(event) {
    const activeDashboard = get().dashboard
    const activeDashboardId = activeDashboard?.id ?? null
    const eventDashboardId = getEventDashboardId(event)
    const isLayoutOnlyEvent = isLayoutOnlyDashboardEvent(event)
    const shouldSkipSummaryReload = canSkipDashboardSummaryReload(event)
    const shouldSurfaceAccessLoss = isDashboardShareEvent(event) || event.event_type === 'resync'
    const hasLocalMutationEcho =
      event.event_type !== 'resync' && consumePendingDashboardMutationEcho(event)
    const shouldSuppressLocalMutationReload =
      hasLocalMutationEcho && canSuppressLocalDashboardEcho(event)

    const { summaries, summariesLoaded, summariesLoading } = get()
    let summariesRefreshPromise: Promise<void> | null = null
    if (summariesLoaded || summariesLoading || summaries.length > 0) {
      if (shouldSkipSummaryReload) {
        set((state) => {
          const nextSummaries = applyLocalDashboardSummaryUpdate(state.summaries, event)
          return nextSummaries === state.summaries ? state : { summaries: nextSummaries }
        })
      } else if (!shouldSuppressLocalMutationReload) {
        summariesRefreshPromise =
          event.event_type === 'resync'
            ? get().loadSummaries(true)
            : scheduleSummariesRefresh(() => get().loadSummaries(true))
      }
    }

    if (
      activeDashboardId &&
      (event.event_type === 'resync' || eventDashboardId === activeDashboardId)
    ) {
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

      await Promise.all([
        summariesRefreshPromise,
        get().loadDashboard(activeDashboardId, {
          background: true,
          surfaceAccessLoss: shouldSurfaceAccessLoss,
        }),
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
          (widget) => !(widget.resource_type === 'list' && widget.resource_id === event.entity_id),
        )
        const removedWidgetIds = new Set(
          state.dashboard.widgets
            .filter(
              (widget) => widget.resource_type === 'list' && widget.resource_id === event.entity_id,
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
}))
