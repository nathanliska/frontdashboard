import { apiGetTrash, apiPurgeDashboard, apiRestoreDashboard } from '../../api/dashboards'
import { sortDashboardSummaries } from '../../utils/dashboard/dashboardEvents'
import { toast } from '../toast'
import {
  createSessionGuard,
  type DashboardGet,
  type DashboardSet,
  type DashboardState,
  type InFlightSummariesLoad,
} from './state'

let inFlightTrashLoad: InFlightSummariesLoad | null = null
let queuedTrashForceReload = false

type TrashSlice = Pick<
  DashboardState,
  'trash' | 'trashLoaded' | 'loadTrash' | 'restoreDashboard' | 'purgeDashboard'
>

export function createTrashSlice(set: DashboardSet, get: DashboardGet): TrashSlice {
  const sessionGuard = () => createSessionGuard(set)

  return {
    trash: [],
    trashLoaded: false,

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

    async purgeDashboard(id) {
      const guard = sessionGuard()
      try {
        await apiPurgeDashboard(id)
        // 204 carries no body, and the row is only ever in the trash cache — drop it there.
        guard.set((s) => ({ trash: s.trash.filter((t) => t.id !== id) }))
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to permanently delete dashboard.')
        return false
      }
    },
  }
}

export function resetTrash(): void {
  inFlightTrashLoad = null
  queuedTrashForceReload = false
}
