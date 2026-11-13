import { apiGetListDetails, type ListDetail } from '../api/lists'
import { registerResourceReset } from './resetRegistry'
import { createScopedQuery } from './scopedQuery'

// Held as a cache entry for what the cache does to a read in flight, not for its data: callers
// always read the network, and the entry is what lets them share one request and tell it is old.
const batchQuery = createScopedQuery<{ dashboardId: string }, ListDetail[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: (scope) => apiGetListDetails(scope.dashboardId),
  fallbackErrorMessage: 'Failed to load lists.',
})

export type DashboardListsRead = {
  lists: ListDetail[]
  /** A list changed while this read was out and nothing has read since, so `lists` may be old. */
  overtaken: boolean
}

/**
 * Every list on a dashboard with its items, in one request.
 *
 * Callers that ask while it is out share it: the agenda and the list widgets all ask as a
 * dashboard opens. One that asks after `markDashboardListsChanged` waits for a read newer than
 * that change.
 */
export async function fetchDashboardLists(dashboardId: string): Promise<DashboardListsRead> {
  const scope = { dashboardId }
  const lists = await batchQuery.fetch(scope)
  // Read here, in the step the batch settles: the next read to start clears the mark.
  return { lists, overtaken: batchQuery.isStale(scope) }
}

/** A list changed, so any batch still out answers from before it. */
export function markDashboardListsChanged(): void {
  batchQuery.invalidateWhere(() => true)
}

export function resetDashboardListsBatch(): void {
  batchQuery.reset()
}

registerResourceReset(resetDashboardListsBatch)
