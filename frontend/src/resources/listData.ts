import { useMemo } from 'react'
import { ApiError } from '../api/http'
import {
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiReorderItems,
  apiReorderLists,
  apiUpdateItem,
  apiUpdateList,
  type ListDetail,
  type ListItem,
  type ListMutationOptions,
  type ListSummary,
  type ListType,
} from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { useAuthStore } from '../stores/auth'
import { toast } from '../stores/toast'
import {
  __resetPendingListMutationsForTests,
  consumePendingListMutation,
  createClientMutationId,
  forgetPendingListMutation,
  recordPendingListMutation,
} from '../utils/lists/listMutation'
import { createScopedQuery } from './scopedQuery'

type ListSummariesScope = {
  dashboardId: string
}

type ListDetailScope = {
  listId: string
}

const listSummariesQuery = createScopedQuery<ListSummariesScope, ListSummary[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: (scope) => apiGetLists(scope.dashboardId),
  fallbackErrorMessage: 'Failed to load lists.',
})

const listDetailQuery = createScopedQuery<ListDetailScope, ListDetail>({
  getKey: (scope) => scope.listId,
  fetcher: (scope) => apiGetList(scope.listId),
  fallbackErrorMessage: 'Failed to load list.',
})

function orderByIds<T extends { id: string }>(rows: T[], orderedIds: string[]): T[] | null {
  if (orderedIds.length !== rows.length) return null // divergence
  if (new Set(orderedIds).size !== orderedIds.length) return null // divergence: duplicate ids
  const byId = new Map(rows.map((r) => [r.id, r]))
  const next: T[] = []
  for (const id of orderedIds) {
    const row = byId.get(id)
    if (!row) return null // divergence
    next.push(row)
  }
  return next
}

function getEventPayload(event: SseEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === 'object' ? event.payload : null
}

function getEventDashboardId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
}

function getAffectedListId(event: SseEvent): string | null {
  if (event.entity_type === 'list') {
    return event.entity_id
  }

  const payload = getEventPayload(event)
  return typeof payload?.list_id === 'string' ? payload.list_id : null
}

function getListEventClientMutationId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.client_mutation_id === 'string' ? payload.client_mutation_id : null
}

function consumePendingListMutationEcho(event: SseEvent): boolean {
  const currentUserId = useAuthStore.getState().user?.id
  const clientMutationId = getListEventClientMutationId(event)
  if (!currentUserId || event.actor_id !== currentUserId || !clientMutationId) {
    return false
  }

  return consumePendingListMutation(clientMutationId)
}

function nextListMutationOptions(): { clientMutationId: string; options: ListMutationOptions } {
  const clientMutationId = createClientMutationId('list')
  recordPendingListMutation(clientMutationId)
  return { clientMutationId, options: { clientMutationId } }
}

function patchListSummaryById(
  listId: string,
  updater: (list: ListSummary) => ListSummary | null,
): void {
  listSummariesQuery.updateWhere(
    () => true,
    (state) => {
      if (!state.data?.some((list) => list.id === listId)) return state

      const nextData = state.data
        .map((list) => (list.id === listId ? updater(list) : list))
        .filter((list): list is ListSummary => list !== null)

      return {
        data: nextData,
        loading: state.loading,
        error: state.error,
      }
    },
  )
}

function patchListDetailById(
  listId: string,
  updater: (detail: ListDetail) => ListDetail | null,
): void {
  listDetailQuery.updateWhere(
    (scope) => scope.listId === listId,
    (state) => {
      if (!state.data) return state

      const nextData = updater(state.data)
      return {
        data: nextData,
        loading: false,
        error: nextData ? state.error : new Error('List not found'),
      }
    },
  )
}

function removeListFromCaches(listId: string): void {
  patchListSummaryById(listId, () => null)
  listDetailQuery.updateWhere(
    (scope) => scope.listId === listId,
    () => ({
      data: null,
      loading: false,
      error: new Error('List not found'),
    }),
  )
}

export function useListSummaries(dashboardId: string | null) {
  const scope = useMemo<ListSummariesScope | null>(
    () => (dashboardId ? { dashboardId } : null),
    [dashboardId],
  )
  return listSummariesQuery.useQuery(scope)
}

export function useListDetail(listId: string | null) {
  const scope = useMemo<ListDetailScope | null>(() => (listId ? { listId } : null), [listId])
  return listDetailQuery.useQuery(scope)
}

export async function loadDashboardListDetails(dashboardId: string): Promise<ListDetail[]> {
  const lists = await listSummariesQuery.fetchIfStale({ dashboardId })
  const activeLists = lists.filter((list) => !list.archived)
  return Promise.all(activeLists.map((list) => listDetailQuery.fetchIfStale({ listId: list.id })))
}

export function readDashboardListDetailsFromCache(dashboardId: string): ListDetail[] | null {
  const summaries = listSummariesQuery.getState({ dashboardId }).data
  if (!summaries) return null

  const activeLists = summaries.filter((list) => !list.archived)
  const details = activeLists.map((list) => listDetailQuery.getState({ listId: list.id }).data)
  if (details.some((detail) => !detail)) return null

  return details as ListDetail[]
}

export async function createList(
  name: string,
  listType: ListType,
  dashboardId: string,
): Promise<ListSummary> {
  const { clientMutationId, options } = nextListMutationOptions()
  const list = await apiCreateList(
    {
      name,
      list_type: listType,
      dashboard_id: dashboardId,
    },
    options,
  ).catch((error) => {
    forgetPendingListMutation(clientMutationId)
    throw error
  })

  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => ({
      data: state.data ? [...state.data, list] : [list],
      loading: state.loading,
      error: state.error,
    }),
  )

  return list
}

export async function updateListName(id: string, name: string): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    const updated = await apiUpdateList(id, { name }, options)
    patchListSummaryById(id, () => updated)
    patchListDetailById(id, (detail) => ({
      ...detail,
      name: updated.name,
      updated_at: updated.updated_at,
    }))
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to rename list.')
    throw error instanceof Error ? error : new Error('Failed to rename list.')
  }
}

export async function archiveList(id: string, archived: boolean): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    const updated = await apiUpdateList(id, { archived }, options)
    patchListSummaryById(id, () => updated)
    patchListDetailById(id, (detail) => ({ ...detail, archived }))
  } catch {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to archive list.')
  }
}

export async function deleteList(id: string): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    await apiDeleteList(id, options)
    removeListFromCaches(id)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to delete list.')
    throw error instanceof Error ? error : new Error('Failed to delete list.')
  }
}

export async function addListItem(listId: string, text: string): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    const item = await apiCreateItem(listId, text, options)
    patchListDetailById(listId, (detail) => ({
      ...detail,
      items: [...detail.items, item],
      item_count: detail.item_count + 1,
    }))
    patchListSummaryById(listId, (list) => ({
      ...list,
      item_count: list.item_count + 1,
    }))
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to add item.')
    throw error instanceof Error ? error : new Error('Failed to add item.')
  }
}

export async function updateListItem(
  listId: string,
  itemId: string,
  body: { text?: string; checked?: boolean },
): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    const item: ListItem = await apiUpdateItem(listId, itemId, body, options)
    patchListDetailById(listId, (detail) => ({
      ...detail,
      items: detail.items.map((current) => (current.id === itemId ? item : current)),
    }))
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error(body.text != null ? 'Failed to rename item.' : 'Failed to update item.')
    if (body.text != null) {
      throw error instanceof Error ? error : new Error('Failed to rename item.')
    }
  }
}

export async function deleteListItem(listId: string, itemId: string): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    await apiDeleteItem(listId, itemId, options)
    patchListDetailById(listId, (detail) => ({
      ...detail,
      items: detail.items.filter((item) => item.id !== itemId),
      item_count: Math.max(0, detail.item_count - 1),
    }))
    patchListSummaryById(listId, (list) => ({
      ...list,
      item_count: Math.max(0, list.item_count - 1),
    }))
  } catch {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to delete item.')
  }
}

export async function reorderListItems(listId: string, orderedIds: string[]): Promise<void> {
  const previous = listDetailQuery.getState({ listId }).data?.items ?? null
  const { clientMutationId, options } = nextListMutationOptions()

  patchListDetailById(listId, (detail) => {
    const items = orderByIds(detail.items, orderedIds)
    return items ? { ...detail, items } : detail
  })

  try {
    await apiReorderItems(listId, orderedIds, options)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    if (previous) {
      patchListDetailById(listId, (detail) => ({ ...detail, items: previous }))
    }
    if (error instanceof ApiError && error.status === 409) {
      listDetailQuery.invalidateWhere((scope) => scope.listId === listId)
      toast.error('Could not save order — refreshed.')
    } else {
      toast.error("Couldn't save the new order.")
    }
  }
}

/**
 * Apply an Active-only list order to a full set of summaries.
 *
 * `orderedIds` covers only non-archived lists (the sidebar reorders the Active
 * view, and the server renumbers only non-archived rows), while the cache holds
 * every summary for the dashboard. Archived rows keep their stale `sort_order`
 * and are appended after the active ones.
 *
 * Both the optimistic mutation and the `list.reordered` SSE branch go through
 * here so their results cannot drift apart. Returns `null` on divergence.
 */
function applyActiveListOrder(rows: ListSummary[], orderedIds: string[]): ListSummary[] | null {
  const archived = rows.filter((l) => l.archived)
  const active = rows.filter((l) => !l.archived)
  const orderedActive = orderByIds(active, orderedIds)
  return orderedActive ? [...orderedActive, ...archived] : null
}

export async function reorderLists(dashboardId: string, orderedIds: string[]): Promise<void> {
  const previous = listSummariesQuery.getState({ dashboardId }).data ?? null
  const { clientMutationId, options } = nextListMutationOptions()

  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => {
      if (!state.data) return state
      const ordered = applyActiveListOrder(state.data, orderedIds)
      return ordered ? { ...state, data: ordered } : state
    },
  )

  try {
    await apiReorderLists(dashboardId, orderedIds, options)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    if (previous) {
      listSummariesQuery.updateWhere(
        (scope) => scope.dashboardId === dashboardId,
        (state) => ({ ...state, data: previous }),
      )
    }
    if (error instanceof ApiError && error.status === 409) {
      listSummariesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
      toast.error('Could not save order — refreshed.')
    } else {
      toast.error("Couldn't save the new order.")
    }
  }
}

export function handleListResourceEvent(event: SseEvent): void {
  if (event.event_type === 'resync') {
    listSummariesQuery.invalidateWhere(() => true)
    listDetailQuery.invalidateWhere(() => true)
    return
  }

  if (!event.event_type.startsWith('list.')) return

  const dashboardId = getEventDashboardId(event)
  const affectedListId = getAffectedListId(event)
  if (consumePendingListMutationEcho(event)) {
    return
  }

  if (event.event_type === 'list.item.reordered') {
    const payload = getEventPayload(event)
    const itemIds = Array.isArray(payload?.item_ids) ? (payload.item_ids as string[]) : null
    if (affectedListId && itemIds) {
      let diverged = false
      patchListDetailById(affectedListId, (detail) => {
        const items = orderByIds(detail.items, itemIds)
        if (!items) {
          diverged = true
          return detail
        }
        return { ...detail, items }
      })
      if (diverged) listDetailQuery.invalidateWhere((scope) => scope.listId === affectedListId)
    }
    return
  }

  if (event.event_type === 'list.reordered') {
    const payload = getEventPayload(event)
    const listIds = Array.isArray(payload?.list_ids) ? (payload.list_ids as string[]) : null
    if (dashboardId && listIds) {
      let diverged = false
      listSummariesQuery.updateWhere(
        (scope) => scope.dashboardId === dashboardId,
        (state) => {
          if (!state.data) return state
          const ordered = applyActiveListOrder(state.data, listIds)
          if (!ordered) {
            diverged = true
            return state
          }
          return { ...state, data: ordered }
        },
      )
      if (diverged) listSummariesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
    }
    return
  }

  if (event.event_type === 'list.deleted' && affectedListId) {
    removeListFromCaches(affectedListId)
    return
  }

  const isItemEvent = event.entity_type === 'list_item'
  const shouldReloadSummaries =
    !isItemEvent ||
    event.event_type === 'list.item.created' ||
    event.event_type === 'list.item.deleted'

  if (dashboardId && shouldReloadSummaries) {
    listSummariesQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
  }

  if (affectedListId) {
    listDetailQuery.invalidateWhere((scope) => scope.listId === affectedListId)
  }
}

export function resetListData(): void {
  listSummariesQuery.reset()
  listDetailQuery.reset()
}

export function __resetListDataForTests(): void {
  resetListData()
  __resetPendingListMutationsForTests()
}

export function __seedListDetailForTests(listId: string, detail: ListDetail): void {
  listDetailQuery.getState({ listId })
  listDetailQuery.updateWhere(
    (scope) => scope.listId === listId,
    () => ({ data: detail, loading: false, error: null }),
  )
}

export function __seedListSummariesForTests(dashboardId: string, summaries: ListSummary[]): void {
  listSummariesQuery.getState({ dashboardId })
  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    () => ({ data: summaries, loading: false, error: null }),
  )
}
