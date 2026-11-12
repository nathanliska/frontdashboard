import { useMemo } from 'react'
import { ApiError } from '../api/http'
import {
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetListDetails,
  apiGetLists,
  apiReorderItems,
  apiReorderLists,
  apiRestoreList,
  apiUpdateItem,
  apiUpdateList,
  type ListDetail,
  type ListItem,
  type ListSummary,
  type ListType,
  retireListDetailRequests,
} from '../api/lists'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { useAuthStore } from '../stores/auth'
import { currentSessionGeneration } from '../stores/sessionGeneration'
import { toast } from '../stores/toast'
import { isOwnFrame } from '../utils/shared/clientInstance'
import {
  applyAgendaItemUpdate,
  invalidateAgendaReminders,
  listHandlerUpdatesAgenda,
  removeAgendaItems,
  removeAgendaItemsForList,
  renameAgendaListEntries,
} from './agendaData'
import { registerResourceReset } from './resetRegistry'
import { createScopedQuery } from './scopedQuery'

type ListSummariesScope = {
  dashboardId: string
  // Load through the dashboard's batch, so picking a list afterwards has its items already.
  withItems?: boolean
}

type ListDetailScope = {
  listId: string
  // The dashboard showing this list, when there is one: its batch can answer the first load.
  dashboardId?: string
}

const listSummariesQuery = createScopedQuery<ListSummariesScope, ListSummary[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: async (scope) => {
    if (!scope.withItems) return apiGetLists(scope.dashboardId)
    return (await loadDashboardLists(scope.dashboardId)).map(toSummary)
  },
  fallbackErrorMessage: 'Failed to load lists.',
})

const listDetailQuery = createScopedQuery<ListDetailScope, ListDetail>({
  getKey: (scope) => scope.listId,
  fetcher: async (scope) => {
    // Only a first load rides the batch: a refetch wants this one list, not every list.
    if (!scope.dashboardId || hasListDetail(scope.listId)) return apiGetList(scope.listId)
    const lists = await loadDashboardLists(scope.dashboardId)
    return lists.find((list) => list.id === scope.listId) ?? apiGetList(scope.listId)
  },
  fallbackErrorMessage: 'Failed to load list.',
})

function hasListDetail(listId: string): boolean {
  return listDetailQuery.getState({ listId }).data !== null
}

function toSummary({ items: _items, ...summary }: ListDetail): ListSummary {
  return summary
}

// Counts list events, so a batch can tell that one arrived while it was in flight.
let listEventEpoch = 0

/**
 * Every list on a dashboard, seeding both caches on the way — but never over an entry that has
 * data, which may already carry patches newer than this response.
 */
async function loadDashboardLists(dashboardId: string): Promise<ListDetail[]> {
  const generation = currentSessionGeneration()
  const epoch = listEventEpoch
  const lists = await apiGetListDetails(dashboardId)
  // Seeding marks an entry fresh, which a response from before a sign-out or a list event is not.
  if (generation !== currentSessionGeneration() || epoch !== listEventEpoch) return lists
  for (const list of lists) {
    if (!hasListDetail(list.id)) listDetailQuery.seed({ listId: list.id }, list)
  }
  if (listSummariesQuery.getState({ dashboardId }).data === null) {
    listSummariesQuery.seed({ dashboardId }, lists.map(toSummary))
  }
  return lists
}

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

export function useListSummaries(
  dashboardId: string | null,
  { withItems = false }: { withItems?: boolean } = {},
) {
  const scope = useMemo<ListSummariesScope | null>(
    () => (dashboardId ? { dashboardId, withItems } : null),
    [dashboardId, withItems],
  )
  return listSummariesQuery.useQuery(scope)
}

export function useListDetail(listId: string | null, dashboardId?: string) {
  const scope = useMemo<ListDetailScope | null>(
    () => (listId ? { listId, dashboardId } : null),
    [listId, dashboardId],
  )
  return listDetailQuery.useQuery(scope)
}

export async function createList(
  name: string,
  listType: ListType,
  dashboardId: string,
): Promise<ListSummary> {
  const list = await apiCreateList({
    name,
    list_type: listType,
    dashboard_id: dashboardId,
  })
  applyCreatedList(list)
  return list
}

/** Puts a list this client just created into both caches, so opening it fetches nothing. */
export function applyCreatedList(list: ListSummary): void {
  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === list.dashboard_id,
    (state) => ({
      data: state.data ? [...state.data, list] : [list],
      loading: state.loading,
      error: state.error,
    }),
  )
  // A new list has no items, so the create response is its whole detail.
  listDetailQuery.seed({ listId: list.id }, { ...list, items: [] })
}

export async function updateListName(id: string, name: string): Promise<void> {
  try {
    const updated = await apiUpdateList(id, { name })
    patchListSummaryById(id, () => updated)
    patchListDetailById(id, (detail) => ({
      ...detail,
      name: updated.name,
      updated_at: updated.updated_at,
    }))
    // Each agenda reminder displays its list's name, so a rename has to reach them too.
    renameAgendaListEntries(id, updated.name)
  } catch (error) {
    toast.error('Failed to rename list.')
    throw error instanceof Error ? error : new Error('Failed to rename list.')
  }
}

export async function deleteList(id: string): Promise<void> {
  try {
    await apiDeleteList(id)
    removeListFromCaches(id)
    removeAgendaItemsForList(id)
  } catch (error) {
    toast.error('Failed to move list to trash.')
    throw error instanceof Error ? error : new Error('Failed to move list to trash.')
  }
}

export async function restoreList(id: string, dashboardId: string): Promise<ListSummary | null> {
  try {
    const restored = await apiRestoreList(id)
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
    toast.error(error instanceof Error ? error.message : 'Failed to restore list.')
    return null
  }
}

export async function addListItem(listId: string, text: string): Promise<void> {
  try {
    const item = await apiCreateItem(listId, text)
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
    // Say what the server said — a refusal the caller can act on (a quota, say) is useless as
    // "Failed to add item".
    const message = error instanceof Error ? error.message : 'Failed to add item.'
    toast.error(message)
    throw error instanceof Error ? error : new Error(message)
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
  body: { text?: string; checked?: boolean; due_date?: string | null },
): Promise<void> {
  try {
    const item: ListItem = await apiUpdateItem(listId, itemId, body)
    patchListDetailById(listId, (detail) => ({
      ...detail,
      items: detail.items.map((current) => (current.id === itemId ? item : current)),
    }))
    // The agenda derives its reminders from these same items with a pure transform, so applying
    // the response here is what lets its SSE echo be ignored instead of triggering a refetch.
    // Read after the patch so the detail is the post-mutation one.
    patchAgendaFromListDetail(listId, item)
  } catch (error) {
    toast.error(body.text != null ? 'Failed to rename item.' : 'Failed to update item.')
    // Always rethrow: a swallowed failure made the add box's restore path clear the user's
    // text over a PATCH that never landed. Callers that can't act on it catch and drop.
    throw error instanceof Error ? error : new Error('Failed to update item.')
  }
}

export async function deleteListItem(listId: string, itemId: string): Promise<void> {
  try {
    await apiDeleteItem(listId, itemId)
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
    toast.error('Failed to delete item.')
  }
}

export async function reorderListItems(listId: string, orderedIds: string[]): Promise<void> {
  const previous = listDetailQuery.getState({ listId }).data?.items ?? null

  patchListDetailById(listId, (detail) => {
    const items = orderByIds(detail.items, orderedIds)
    return items ? { ...detail, items } : detail
  })

  try {
    await apiReorderItems(listId, orderedIds)
  } catch (error) {
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

  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => {
      if (!state.data) return state
      const ordered = orderByIds(state.data, orderedIds)
      return ordered ? { ...state, data: ordered } : state
    },
  )

  try {
    await apiReorderLists(dashboardId, orderedIds)
  } catch (error) {
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
  // Decided once by the SSE router and shared with the other handlers; the check is a pure
  // comparison now, so the default exists only so a lone caller (tests) still behaves.
  { isOwnEcho }: { isOwnEcho?: boolean } = {},
): void {
  if (event.event_type !== 'resync' && !event.event_type.startsWith('list.')) return

  // A batch opened before this event predates it: it may not seed, and nobody new may join it.
  listEventEpoch += 1
  retireListDetailRequests()

  if (event.event_type === 'resync') {
    listSummariesQuery.invalidateWhere(() => true)
    listDetailQuery.invalidateWhere(() => true)
    return
  }

  const dashboardId = getEventDashboardId(event)
  const affectedListId = getAffectedListId(event)
  if (isOwnEcho ?? isOwnFrame(event, useAuthStore.getState().user?.id)) {
    return
  }

  if (event.event_type === 'list.item.checked' || event.event_type === 'list.item.updated') {
    const values = event.payload.values
    const itemId = event.entity_id
    // Only patch when the event carries the new values; otherwise fall through to
    // invalidate-and-refetch so an older/unknown payload still converges.
    if (affectedListId && listHandlerUpdatesAgenda(event) && values) {
      // No data yet (never loaded, in flight, or errored) means nothing to patch: count that as
      // divergence up front, or patchListDetailById's null guard no-ops and the event is neither
      // applied nor recorded, so the eventual GET resolves with pre-event data forever.
      // A stale entry counts too: its list name or item may be out of date, and the agenda is
      // rebuilt from them below.
      let diverged =
        listDetailQuery.getState({ listId: affectedListId }).data === null ||
        listDetailQuery.isStale({ listId: affectedListId })
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
        // Nothing here to rebuild the reminder from, so the agenda has to read it.
        invalidateAgendaReminders(dashboardId)
      } else {
        const patched = listDetailQuery
          .getState({ listId: affectedListId })
          .data?.items.find((item) => item.id === itemId)
        if (patched) patchAgendaFromListDetail(affectedListId, patched)
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

  if (event.event_type === 'list.item.deleted' && affectedListId) {
    const itemId = event.entity_id
    // A reminder is keyed by its item, so the agenda needs no list data to drop one.
    removeAgendaItems([itemId])
    const held = listDetailQuery.getState({ listId: affectedListId }).data
    if (held?.items.some((item) => item.id === itemId)) {
      patchListDetailById(affectedListId, (detail) => ({
        ...detail,
        items: detail.items.filter((item) => item.id !== itemId),
        item_count: Math.max(0, detail.item_count - 1),
      }))
      patchListSummaryById(affectedListId, (list) => ({
        ...list,
        item_count: Math.max(0, list.item_count - 1),
      }))
      return
    }
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

function resetListData(): void {
  listSummariesQuery.reset()
  listDetailQuery.reset()
}

registerResourceReset(resetListData)

export function __resetListDataForTests(): void {
  resetListData()
}

export function __seedListDetailForTests(listId: string, detail: ListDetail): void {
  listDetailQuery.seed({ listId }, detail)
}

export function __seedListSummariesForTests(dashboardId: string, summaries: ListSummary[]): void {
  listSummariesQuery.getState({ dashboardId })
  listSummariesQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    () => ({ data: summaries, loading: false, error: null }),
  )
}
