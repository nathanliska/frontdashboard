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
  apiRestoreList,
  apiUpdateItem,
  apiUpdateList,
  type ListDetail,
  type ListItem,
  type ListMutationOptions,
  type ListSummary,
  type ListType,
} from '../api/lists'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { useAuthStore } from '../stores/auth'
import { toast } from '../stores/toast'
import {
  __resetPendingListMutationsForTests,
  consumePendingListMutation,
  createClientMutationId,
  forgetPendingListMutation,
  recordPendingListMutation,
} from '../utils/lists/listMutation'
import {
  applyAgendaItemUpdate,
  invalidateAgendaReminders,
  removeAgendaItems,
  removeAgendaItemsForList,
  renameAgendaListEntries,
} from './agendaData'
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

function getEventDashboardId(event: SseEvent): string | null {
  return event.payload.dashboard_id ?? null
}

function getAffectedListId(event: SseEvent): string | null {
  if (event.entity_type === 'list') {
    return event.entity_id
  }

  return event.payload.list_id ?? null
}

function getListEventClientMutationId(event: SseEvent): string | null {
  return event.payload.client_mutation_id ?? null
}

export function consumePendingListMutationEcho(event: SseEvent): boolean {
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
    // Each agenda reminder displays its list's name, so a rename has to reach them too.
    renameAgendaListEntries(id, updated.name)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to rename list.')
    throw error instanceof Error ? error : new Error('Failed to rename list.')
  }
}

export async function deleteList(id: string): Promise<void> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    await apiDeleteList(id, options)
    removeListFromCaches(id)
    removeAgendaItemsForList(id)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to move list to trash.')
    throw error instanceof Error ? error : new Error('Failed to move list to trash.')
  }
}

export async function restoreList(id: string, dashboardId: string): Promise<ListSummary | null> {
  const { clientMutationId, options } = nextListMutationOptions()
  try {
    const restored = await apiRestoreList(id, options)
    // The response is the restored row, so the summaries cache is patched from it rather than
    // refetched; the SSE echo for our own mutation is suppressed.
    listSummariesQuery.updateWhere(
      (scope) => scope.dashboardId === dashboardId,
      (state) =>
        state.data
          ? { ...state, data: [...state.data.filter((l) => l.id !== id), restored] }
          : state,
    )
    // The one list mutation whose agenda effect cannot be derived: the response is a summary, so
    // the restored list's items — and therefore its reminders — are not in hand.
    invalidateAgendaReminders(dashboardId)
    return restored
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error(error instanceof Error ? error.message : 'Failed to restore list.')
    return null
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
    // A new item carries no due date, so this derives to "not on the agenda" and is a no-op
    // today. It runs anyway so the agenda stays correct by construction if creation ever gains
    // one, rather than silently dropping it.
    patchAgendaFromListDetail(listId, item)
  } catch (error) {
    forgetPendingListMutation(clientMutationId)
    toast.error('Failed to add item.')
    throw error instanceof Error ? error : new Error('Failed to add item.')
  }
}

/** Re-derive an item's agenda entry after a mutation, using the cached list for its dashboard.
 *
 * The detail cache is always populated here in practice: you can only act on an item you are
 * looking at, and both surfaces that mutate one (the list widget and the list page) read it
 * through `useListDetail`. If it somehow is not, the agenda simply keeps its current entry until
 * its next natural refresh rather than showing something wrong.
 */
function patchAgendaFromListDetail(listId: string, item: ListItem): void {
  const detail = listDetailQuery.getState({ listId }).data
  if (!detail) return
  applyAgendaItemUpdate(detail.dashboard_id, item, { id: detail.id, name: detail.name })
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
    // The agenda derives its reminders from these same items with a pure transform, so applying
    // the response here is what lets its SSE echo be ignored instead of triggering a refetch.
    // Read after the patch so the detail is the post-mutation one.
    patchAgendaFromListDetail(listId, item)
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
    removeAgendaItems([itemId])
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

export async function reorderLists(dashboardId: string, orderedIds: string[]): Promise<void> {
  const previous = listSummariesQuery.getState({ dashboardId }).data ?? null
  const { clientMutationId, options } = nextListMutationOptions()

  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => {
      if (!state.data) return state
      const ordered = orderByIds(state.data, orderedIds)
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

// Fields an item-update event may patch. Identity, ownership and timestamps are
// never taken from the payload: a stray `id` would silently break React keys and
// send every later event for this item down the divergence path.
const PATCHABLE_ITEM_FIELDS = [
  'text',
  'checked',
  'due_date',
  'priority',
  'category',
  'assigned_to',
] as const

function pickPatchableItemFields(values: Record<string, unknown>): Partial<ListItem> {
  const patch: Record<string, unknown> = {}
  for (const field of PATCHABLE_ITEM_FIELDS) {
    if (field in values) patch[field] = values[field]
  }
  return patch as Partial<ListItem>
}

export function handleListResourceEvent(
  event: ResourceEvent,
  // Decided once by the SSE router and shared, because `consumePendingListMutationEcho` deletes
  // the pending id — only the first handler to ask can learn the truth, and there are three.
  // Defaults to asking directly so a lone caller (tests, a direct dispatch) still behaves.
  { isOwnEcho }: { isOwnEcho?: boolean } = {},
): void {
  if (event.event_type === 'resync') {
    listSummariesQuery.invalidateWhere(() => true)
    listDetailQuery.invalidateWhere(() => true)
    return
  }

  if (!event.event_type.startsWith('list.')) return

  const dashboardId = getEventDashboardId(event)
  const affectedListId = getAffectedListId(event)
  if (isOwnEcho ?? consumePendingListMutationEcho(event)) {
    return
  }

  if (event.event_type === 'list.item.checked' || event.event_type === 'list.item.updated') {
    const values = event.payload.values
    const itemId = event.entity_id
    // Only patch when the event carries the new values; otherwise fall through to
    // invalidate-and-refetch so an older/unknown payload still converges.
    if (affectedListId && values) {
      // If the cache has no data yet (never loaded, still in flight, or the last fetch
      // errored), there is nothing to patch — treat that as divergence up front rather than
      // letting patchListDetailById's `if (!state.data) return state` guard silently no-op
      // the updater below. Otherwise `diverged` would stay false and this event would be
      // neither applied nor recorded, so the eventual GET resolves with pre-event data forever.
      let diverged = listDetailQuery.getState({ listId: affectedListId }).data === null
      if (!diverged) {
        patchListDetailById(affectedListId, (detail) => {
          if (!detail.items.some((item) => item.id === itemId)) {
            diverged = true
            return detail
          }
          return {
            ...detail,
            items: detail.items.map((item) =>
              item.id === itemId ? { ...item, ...pickPatchableItemFields(values) } : item,
            ),
          }
        })
      }
      if (diverged) {
        listDetailQuery.invalidateWhere((scope) => scope.listId === affectedListId)
      }
      // Early return skips the generic tail's shouldReloadSummaries check below. That's
      // only safe because shouldReloadSummaries is false for these two event types — if a
      // future summary-visible field is added to the patchable set, revisit this.
      return
    }
  }

  if (event.event_type === 'list.item.reordered') {
    const itemIds = event.payload.item_ids ?? null
    if (affectedListId && itemIds) {
      // Same absent-cache hole as the item-update branch above: no data means nothing to
      // patch, and patchListDetailById's no-op guard would otherwise swallow the event.
      let diverged = listDetailQuery.getState({ listId: affectedListId }).data === null
      if (!diverged) {
        patchListDetailById(affectedListId, (detail) => {
          const items = orderByIds(detail.items, itemIds)
          if (!items) {
            diverged = true
            return detail
          }
          return { ...detail, items }
        })
      }
      if (diverged) listDetailQuery.invalidateWhere((scope) => scope.listId === affectedListId)
    }
    return
  }

  if (event.event_type === 'list.reordered') {
    const listIds = event.payload.list_ids ?? null
    if (dashboardId && listIds) {
      // Same absent-cache hole: if the summaries cache has no data yet, updateWhere's
      // `if (!state.data) return state` guard would otherwise no-op the updater and this
      // event would be silently dropped instead of marking the entry stale.
      let diverged = listSummariesQuery.getState({ dashboardId }).data === null
      if (!diverged) {
        listSummariesQuery.updateWhere(
          (scope) => scope.dashboardId === dashboardId,
          (state) => {
            if (!state.data) return state
            const ordered = orderByIds(state.data, listIds)
            if (!ordered) {
              diverged = true
              return state
            }
            return { ...state, data: ordered }
          },
        )
      }
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
