import { apiUpdatePreferences } from '../../api/auth'
import {
  apiCreateDashboard,
  apiDeleteDashboard,
  apiLeaveDashboard,
  apiListDashboards,
  apiTransferDashboardOwnership,
  apiUpdateDashboardMeta,
} from '../../api/dashboards'
import { sortDashboardSummaries } from '../../utils/dashboard/dashboardEvents'
import { useAuthStore } from '../auth'
import { toast } from '../toast'
import {
  createSessionGuard,
  type DashboardGet,
  type DashboardSet,
  type DashboardState,
  type InFlightSummariesLoad,
} from './state'

let inFlightSummariesLoad: InFlightSummariesLoad | null = null
let queuedSummariesForceReload = false

type CollectionSlice = Pick<
  DashboardState,
  | 'summaries'
  | 'summariesLoaded'
  | 'summariesLoading'
  | 'loadSummaries'
  | 'createDashboard'
  | 'deleteDashboard'
  | 'leaveDashboard'
  | 'toggleFavorite'
  | 'renameDashboard'
  | 'transferDashboard'
>

export function createCollectionSlice(set: DashboardSet, get: DashboardGet): CollectionSlice {
  const sessionGuard = () => createSessionGuard(set)

  return {
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,

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
        const created = await apiCreateDashboard(data)
        // The answer is both the listing row and the whole board, so opening it fetches nothing.
        const { layout: _layout, widgets: _widgets, ...summary } = created
        guard.set((s) => ({
          summaries: [summary, ...s.summaries],
          dashboard: created,
          conflict: false,
          loadError: false,
        }))
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

    async leaveDashboard(id) {
      const guard = sessionGuard()
      try {
        await apiLeaveDashboard(id)
        // Not the trash: the dashboard still exists for everyone else — only this account's
        // access is gone, so the summary just disappears.
        guard.set((s) => ({
          summaries: s.summaries.filter((d) => d.id !== id),
          ...(s.dashboard?.id === id ? { dashboard: null } : {}),
        }))
        return true
      } catch {
        toast.error('Failed to leave dashboard.')
        return false
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

    async transferDashboard(id, userId) {
      const guard = sessionGuard()
      try {
        const updated = await apiTransferDashboardOwnership(id, userId)
        guard.set((s) => ({
          summaries: sortDashboardSummaries(s.summaries.map((d) => (d.id === id ? updated : d))),
          dashboard:
            s.dashboard?.id === id
              ? {
                  ...s.dashboard,
                  user_id: updated.user_id,
                  can_edit: updated.can_edit,
                  can_manage_shares: updated.can_manage_shares,
                }
              : s.dashboard,
        }))
        return true
      } catch {
        toast.error('Failed to transfer ownership.')
        return false
      }
    },
  }
}

export function resetCollection(): void {
  inFlightSummariesLoad = null
  queuedSummariesForceReload = false
}
