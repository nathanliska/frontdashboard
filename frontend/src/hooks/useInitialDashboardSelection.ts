import { useEffect, useState } from 'react'
import type { DashboardSummary } from '../api/dashboards'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'

export function pickInitialDashboardId(
  dashboards: DashboardSummary[],
  requestedDashboardId: string | null,
): string | null {
  const activeDashboards = dashboards.filter((dashboard) => !dashboard.archived)
  const requestedDashboard = requestedDashboardId
    ? activeDashboards.find((dashboard) => dashboard.id === requestedDashboardId)
    : null

  return (
    requestedDashboard?.id ??
    activeDashboards.find((dashboard) => dashboard.is_favorite)?.id ??
    activeDashboards[0]?.id ??
    null
  )
}

export function useInitialDashboardSelection(
  requestedDashboardId: string | null,
  loadErrorMessage: string,
) {
  const loadSummaries = useDashboardStore((state) => state.loadSummaries)
  const [dashboardId, setDashboardId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadInitialDashboard() {
      try {
        await loadSummaries()
        if (cancelled) return

        setDashboardId(
          pickInitialDashboardId(useDashboardStore.getState().summaries, requestedDashboardId),
        )
      } catch {
        if (!cancelled) {
          toast.error(loadErrorMessage)
        }
      }
    }

    void loadInitialDashboard()

    return () => {
      cancelled = true
    }
  }, [loadErrorMessage, loadSummaries, requestedDashboardId])

  return [dashboardId, setDashboardId] as const
}
