import { useMemo } from 'react'
import { apiListDashboardMembers } from '../api/dashboards'
import type { DashboardMemberResponse } from '../api/generated/contract'
import type { ResourceEvent } from '../hooks/useSSE'
import { registerResourceReset } from './resetRegistry'
import { createScopedQuery } from './scopedQuery'

type MembersScope = {
  dashboardId: string
}

const dashboardMembersQuery = createScopedQuery<MembersScope, DashboardMemberResponse[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: (scope) => apiListDashboardMembers(scope.dashboardId),
  fallbackErrorMessage: 'Failed to load members.',
})

/** The dashboard's roster, cached across editor opens and refreshed by share events. */
export function useDashboardMembers(dashboardId: string | null) {
  const scope = useMemo<MembersScope | null>(
    () => (dashboardId ? { dashboardId } : null),
    [dashboardId],
  )
  return dashboardMembersQuery.useQuery(scope)
}

export function handleMembersResourceEvent(event: ResourceEvent): void {
  if (event.event_type === 'resync') {
    dashboardMembersQuery.invalidateWhere(() => true)
    return
  }

  // Never echo-gated: no mutation path patches this cache, so the owner's own share change must
  // invalidate it the same as anyone else's.
  if (!event.event_type.startsWith('dashboard.share_')) return

  const dashboardId = event.entity_id
  dashboardMembersQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
}

export function resetMembersData(): void {
  dashboardMembersQuery.reset()
}

registerResourceReset(resetMembersData)
