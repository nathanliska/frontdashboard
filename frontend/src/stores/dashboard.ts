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
import type { ShareCreate } from '../api/shares'
import type { SseEvent } from '../hooks/useSSE'
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

interface DashboardState {
  // ── Listing ────────────────────────────────────────────────────────────────
  summaries: DashboardSummary[]
  summariesLoading: boolean

  // ── Active editor ──────────────────────────────────────────────────────────
  dashboard: Dashboard | null
  listContentVersion: number
  calendarContentVersion: number
  loading: boolean
  loadError: boolean // true when loadDashboard fails (404, 403, network)
  conflict: boolean // true when a PUT /layout returns 409 (version mismatch)

  // ── Listing actions ────────────────────────────────────────────────────────
  loadSummaries: () => Promise<void>
  createDashboard: (data: { name: string; shares?: ShareCreate[] }) => Promise<DashboardSummary>
  deleteDashboard: (id: string) => Promise<void>
  toggleFavorite: (id: string, current: boolean) => Promise<void>
  renameDashboard: (id: string, name: string) => Promise<void>

  // ── Editor actions ─────────────────────────────────────────────────────────
  loadDashboard: (id: string) => Promise<void>
  saveLayout: (layout: LayoutItem[]) => Promise<void>
  addWidget: (widget: {
    widget_type: string
    config?: Record<string, unknown>
    resource_type?: string | null
    resource_id?: string | null
  }) => Promise<void>
  removeWidget: (widgetId: string) => Promise<void>
  updateWidget: (widgetId: string, config: Record<string, unknown>) => Promise<void>
  handleContentEvent: (event: SseEvent) => void
  resolveConflict: () => void
}

export const useDashboardStore = create<DashboardState>()((set, get) => ({
  summaries: [],
  summariesLoading: false,
  dashboard: null,
  listContentVersion: 0,
  calendarContentVersion: 0,
  loading: false,
  loadError: false,
  conflict: false,

  // ── Listing ────────────────────────────────────────────────────────────────

  async loadSummaries() {
    const { summaries, summariesLoading } = get()
    if (summaries.length > 0 && !summariesLoading) return
    if (inFlightSummariesLoad) return inFlightSummariesLoad

    set({ summariesLoading: true })
    const promise = (async () => {
      try {
        const nextSummaries = await apiListDashboards()
        set({ summaries: nextSummaries })
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
      const updated = await apiUpdateDashboardMeta(id, { is_favorite: !current })
      set((s) => ({ summaries: s.summaries.map((d) => (d.id === id ? updated : d)) }))
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

  async loadDashboard(id) {
    if (inFlightDashboardLoad?.id === id) {
      return inFlightDashboardLoad.promise
    }

    set({ loading: true, loadError: false })

    const promise = (async () => {
      try {
        const dashboard = await apiGetDashboard(id)
        set({ dashboard, conflict: false, listContentVersion: 0, calendarContentVersion: 0 })
      } catch {
        // 404/403 land here — editor page reads loadError to show an error state
        set({ loadError: true })
      } finally {
        set({ loading: false })
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
      const { data, status } = await apiUpdateLayout(dashboard.id, layout, dashboard.version)
      if (status === 409) {
        // Another editor saved a layout change between our load and this PUT.
        // Surface the conflict banner; user resolves by reloading.
        set({ conflict: true })
        return
      }
      set({ dashboard: data })
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
    const eventDashboardId =
      typeof event.payload.dashboard_id === 'string' ? event.payload.dashboard_id : null
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
