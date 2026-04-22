import { useMemo } from 'react'
import {
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
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
