import { useEffect, useState } from 'react'
import type { DashboardSummary } from '../api/dashboards'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'

function pickInitialDashboardId(
  dashboards: DashboardSummary[],
  requestedDashboardId: string | null,
): string | null {
  const requestedDashboard = requestedDashboardId
    ? dashboards.find((dashboard) => dashboard.id === requestedDashboardId)
    : null

  return (
    requestedDashboard?.id ??
    dashboards.find((dashboard) => dashboard.is_favorite)?.id ??
    dashboards[0]?.id ??
    null
  )
}

export function useInitialDashboardSelection(
  requestedDashboardId: string | null,
  loadErrorMessage: string,
) {
  const loadSummaries = useDashboardStore((state) => state.loadSummaries)
  const [dashboardId, setDashboardId] = useState<string | null>(null)
  const [readyFor, setReadyFor] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false

    async function loadInitialDashboard() {
      try {
        await loadSummaries()
        if (cancelled) return

        setDashboardId(
          pickInitialDashboardId(useDashboardStore.getState().summaries, requestedDashboardId),
        )
        setReadyFor(requestedDashboardId)
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

  return [dashboardId, setDashboardId, readyFor === requestedDashboardId] as const
}
