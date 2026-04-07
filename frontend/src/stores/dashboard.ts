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

let inFlightDashboardLoad: { id: string; promise: Promise<void> } | null = null
let inFlightSummariesLoad: Promise<void> | null = null
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

function getEventDashboardId(event: SseEvent): string | null {
  if (event.entity_type === 'dashboard') {
    return event.entity_id
  }

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : undefined
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
}

type LoadDashboardOptions = {
  background?: boolean
  resetContentVersions?: boolean
}

interface DashboardState {
  // ── Listing ────────────────────────────────────────────────────────────────
  summaries: DashboardSummary[]
  summariesLoaded: boolean
  summariesLoading: boolean

  // ── Active editor ──────────────────────────────────────────────────────────
  dashboard: Dashboard | null
  listContentVersion: number
  calendarContentVersion: number
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
  listContentVersion: 0,
  calendarContentVersion: 0,
  loading: false,
  loadError: false,
  conflict: false,

  // ── Listing ────────────────────────────────────────────────────────────────

  async loadSummaries(force = false) {
    const { summariesLoaded, summariesLoading } = get()
    if (!force && summariesLoaded && !summariesLoading) return
    if (inFlightSummariesLoad) return inFlightSummariesLoad

    set({ summariesLoading: true })
    const promise = (async () => {
      try {
        const nextSummaries = await apiListDashboards()
        set({ summaries: nextSummaries, summariesLoaded: true })
      } catch {
        toast.error('Failed to load dashboards.')
      } finally {
        set({ summariesLoading: false })
        inFlightSummariesLoad = null
      }
    })()

    inFlightSummariesLoad = promise
    return promise
  },

  async createDashboard(data) {
    try {
      const summary = await apiCreateDashboard(data)
      set((s) => ({ summaries: [summary, ...s.summaries] }))
      return summary
    } catch {
      toast.error('Failed to create dashboard.')
      throw new Error('create failed')
    }
  },

  async deleteDashboard(id) {
    try {
      await apiDeleteDashboard(id)
      set((s) => ({ summaries: s.summaries.filter((d) => d.id !== id) }))
    } catch {
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
        dashboard: s.dashboard?.id === id ? { ...s.dashboard, is_favorite: !current } : s.dashboard,
      }))
      await get().loadSummaries(true)
    } catch {
      toast.error('Failed to update favorite.')
    }
  },

  async renameDashboard(id, name) {
    try {
      const updated = await apiUpdateDashboardMeta(id, { name })
      set((s) => ({
        summaries: s.summaries.map((d) => (d.id === id ? updated : d)),
        dashboard: s.dashboard?.id === id ? { ...s.dashboard, name } : s.dashboard,
      }))
    } catch {
      toast.error('Failed to rename dashboard.')
    }
  },

  // ── Editor ─────────────────────────────────────────────────────────────────

  async loadDashboard(id, options = {}) {
    if (inFlightDashboardLoad?.id === id) {
      return inFlightDashboardLoad.promise
    }

    const showLoading = !options.background
    const resetContentVersions = options.resetContentVersions ?? showLoading

    if (showLoading) {
      set({ loading: true, loadError: false })
    }

    const promise = (async () => {
      try {
        const dashboard = await apiGetDashboard(id)
        set((state) => ({
          dashboard,
          conflict: false,
          loadError: false,
          listContentVersion: resetContentVersions ? 0 : state.listContentVersion,
          calendarContentVersion: resetContentVersions ? 0 : state.calendarContentVersion,
          ...(showLoading ? { loading: false } : {}),
        }))
      } catch {
        // 404/403 land here — editor page reads loadError to show an error state.
        // For background SSE refreshes, keep the current dashboard visible instead
        // of swapping to a full-page error on a transient fetch failure.
        set(showLoading ? { loadError: true, loading: false } : {})
      } finally {
        if (showLoading) {
          set({ loading: false })
        }
        if (inFlightDashboardLoad?.id === id) {
          inFlightDashboardLoad = null
        }
      }
    })()

    inFlightDashboardLoad = { id, promise }
    return promise
  },

  async saveLayout(layout) {
    const { dashboard } = get()
    if (!dashboard) return
    try {
      const result = await apiUpdateLayout(dashboard.id, layout, dashboard.version)
      if (result.conflict) {
        // Another editor saved a layout change between our load and this PUT.
        // Surface the conflict banner; user resolves by reloading.
        set({ conflict: true })
        return
      }
      set({ dashboard: result.dashboard, conflict: false })
    } catch {
      toast.error('Failed to save layout.')
    }
  },

  async addWidget(widget) {
    const { dashboard } = get()
    if (!dashboard) return
    try {
      const updated = await apiAddWidget(dashboard.id, widget)
      set({ dashboard: updated })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add widget.')
    }
  },

  async removeWidget(widgetId) {
    const { dashboard } = get()
    if (!dashboard) return
    try {
      await apiRemoveWidget(dashboard.id, widgetId)
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
      toast.error('Failed to remove widget.')
    }
  },

  async updateWidget(widgetId, config) {
    const { dashboard } = get()
    if (!dashboard) return
    try {
      const updated = await apiUpdateWidget(dashboard.id, widgetId, config)
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
      toast.error('Failed to update widget.')
    }
  },

  async handleDashboardEvent(event) {
    const activeDashboardId = get().dashboard?.id ?? null
    const eventDashboardId = getEventDashboardId(event)

    const { summaries, summariesLoaded, summariesLoading } = get()
    let summariesRefreshPromise: Promise<void> | null = null
    if (summariesLoaded || summariesLoading || summaries.length > 0) {
      summariesRefreshPromise =
        event.event_type === 'resync'
          ? get().loadSummaries(true)
          : scheduleSummariesRefresh(() => get().loadSummaries(true))
    }

    if (
      activeDashboardId &&
      (event.event_type === 'resync' || eventDashboardId === activeDashboardId)
    ) {
      if (event.event_type === 'dashboard.deleted' && eventDashboardId === activeDashboardId) {
        set({ dashboard: null, loadError: true, loading: false, conflict: false })
        return
      }

      await Promise.all([
        summariesRefreshPromise,
        get().loadDashboard(activeDashboardId, {
          background: true,
          resetContentVersions: false,
        }),
      ])
      return
    }

    await summariesRefreshPromise
  },

  handleContentEvent(event) {
    if (event.event_type === 'resync') {
      set((state) => ({
        listContentVersion: state.dashboard
          ? state.listContentVersion + 1
          : state.listContentVersion,
        calendarContentVersion: state.dashboard
          ? state.calendarContentVersion + 1
          : state.calendarContentVersion,
      }))
      return
    }

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
          listContentVersion: state.listContentVersion + 1,
        }
      }

      if (event.event_type.startsWith('calendar.')) {
        return { calendarContentVersion: state.calendarContentVersion + 1 }
      }

      if (event.event_type.startsWith('list.')) {
        return { listContentVersion: state.listContentVersion + 1 }
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
