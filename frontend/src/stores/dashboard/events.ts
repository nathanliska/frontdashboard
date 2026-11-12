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
} from '../../utils/dashboard/dashboardEvents'
import { boundListId } from '../../utils/dashboard/widgetBinding'
import { createDebouncedRefresh } from '../../utils/debounce'
import type { DashboardGet, DashboardSet, DashboardState } from './state'

const DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS = 100

const summariesRefresh = createDebouncedRefresh(DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS)
// A widget drag emits one layout event per save; without this each costs every other tab a full
// dashboard GET.
const dashboardRefresh = createDebouncedRefresh(DASHBOARD_SUMMARY_REFRESH_DEBOUNCE_MS)

const scheduleSummariesRefresh = (run: () => Promise<void>) => summariesRefresh.schedule(run)
const scheduleDashboardRefresh = (run: () => Promise<void>) => dashboardRefresh.schedule(run)

type EventsSlice = Pick<DashboardState, 'handleDashboardEvent' | 'handleContentEvent'>

export function createEventsSlice(set: DashboardSet, get: DashboardGet): EventsSlice {
  return {
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
            (widget) => boundListId(widget) !== event.entity_id,
          )
          const removedWidgetIds = new Set(
            state.dashboard.widgets
              .filter((widget) => boundListId(widget) === event.entity_id)
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
  }
}

export function resetEvents(): void {
  summariesRefresh.cancel()
  dashboardRefresh.cancel()
}
