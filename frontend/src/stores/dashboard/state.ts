import type { StoreApi } from 'zustand'
import type {
  Dashboard,
  DashboardSummary,
  LayoutGesture,
  LayoutItem,
  TrashedDashboard,
  WidgetCreate,
} from '../../api/dashboards'
import type { ResourceEvent, SseEvent } from '../../hooks/useSSE'
import type { LoadDashboardOptions } from '../../utils/dashboard/loadOptions'
import { currentSessionGeneration } from '../sessionGeneration'

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
  createDashboard: (data: { name: string }) => Promise<DashboardSummary | null>
  deleteDashboard: (id: string) => Promise<boolean>
  leaveDashboard: (id: string) => Promise<boolean>
  toggleFavorite: (id: string, current: boolean) => Promise<boolean>
  renameDashboard: (id: string, name: string) => Promise<boolean>
  transferDashboard: (id: string, userId: string) => Promise<boolean>
  loadTrash: (force?: boolean) => Promise<void>
  restoreDashboard: (id: string) => Promise<DashboardSummary | null>
  purgeDashboard: (id: string) => Promise<boolean>

  // ── Editor actions ─────────────────────────────────────────────────────────
  loadDashboard: (id: string, options?: LoadDashboardOptions) => Promise<void>
  saveLayout: (layout: LayoutItem[], gesture?: LayoutGesture) => Promise<void>
  addWidget: (widget: WidgetCreate) => Promise<boolean>
  removeWidget: (widgetId: string) => Promise<boolean>
  updateWidget: (widgetId: string, config: Record<string, unknown>) => Promise<boolean>
  handleDashboardEvent: (event: ResourceEvent) => Promise<void>
  handleContentEvent: (event: SseEvent) => void
  resolveConflict: () => void
}

export type DashboardSet = StoreApi<DashboardState>['setState']
export type DashboardGet = StoreApi<DashboardState>['getState']

export type InFlightSummariesLoad = {
  promise: Promise<void>
}

/** A `set` that goes quiet once the session changes, so a late response cannot write into it. */
export function createSessionGuard(set: DashboardSet) {
  const gen = currentSessionGeneration()
  return {
    isCurrent: () => gen === currentSessionGeneration(),
    set: ((...args: Parameters<typeof set>) => {
      if (gen === currentSessionGeneration()) set(...args)
    }) as typeof set,
  }
}
