import { useEffect, useMemo, useRef } from 'react'
import type { CalendarOccurrence } from '../api/calendar'
import type { CalendarEventParticipantResponse } from '../api/generated/contract'
import { apiGetListDetails, type ListItem, type ListSummary } from '../api/lists'
import { useLocalToday } from '../hooks/useLocalDay'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { addDays, dateKey, startOfDay } from '../utils/calendar/calendarUtils'

import { resetOccurrences, useOccurrences } from './occurrenceStore'
import { registerResourceReset } from './resetRegistry'
import { createScopedQuery, type ScopedQueryState } from './scopedQuery'

export type AgendaItem =
  | {
      id: string
      type: 'event'
      title: string
      startsAt: string
      endsAt: string
      allDay: boolean
      recurring: boolean
      participants: CalendarEventParticipantResponse[]
    }
  | {
      id: string
      type: 'reminder'
      title: string
      dueDate: string
      listId: string
      listName: string
      priority: ListItem['priority']
      status: 'overdue' | 'today'
    }

type AgendaScope = {
  dashboardId: string
}

const agendaRemindersQuery = createScopedQuery<AgendaScope, AgendaItem[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: fetchAgendaReminders,
  fallbackErrorMessage: 'Failed to load agenda.',
})

function getDashboardId(event: SseEvent): string | null {
  return event.payload.dashboard_id ?? null
}

function compareAgendaItems(a: AgendaItem, b: AgendaItem): number {
  const rank = (item: AgendaItem) => {
    if (item.type === 'reminder' && item.status === 'overdue') return 0
    if (item.type === 'reminder') return 1
    return 2
  }
  const rankDelta = rank(a) - rank(b)
  if (rankDelta !== 0) return rankDelta

  const aTime = a.type === 'event' ? new Date(a.startsAt).getTime() : new Date(a.dueDate).getTime()
  const bTime = b.type === 'event' ? new Date(b.startsAt).getTime() : new Date(b.dueDate).getTime()
  return aTime - bTime
}

function occurrenceToAgendaItem(occurrence: CalendarOccurrence): AgendaItem {
  return {
    id: `event:${occurrence.event_id}:${occurrence.original_start}`,
    type: 'event',
    title: occurrence.title,
    startsAt: occurrence.occurrence_start,
    endsAt: occurrence.occurrence_end,
    allDay: occurrence.all_day,
    recurring: occurrence.recurring,
    participants: occurrence.participants,
  }
}

function listItemToAgendaItem(
  item: ListItem,
  list: Pick<ListSummary, 'id' | 'name'>,
  todayKey: string,
): AgendaItem | null {
  if (item.checked || !item.due_date || item.due_date > todayKey) return null

  return {
    id: `reminder:${item.id}`,
    type: 'reminder',
    title: item.text,
    dueDate: item.due_date,
    listId: list.id,
    listName: list.name,
    priority: item.priority,
    status: item.due_date < todayKey ? 'overdue' : 'today',
  }
}

/** Re-derive one item's agenda entry from a mutation response, in place of a refetch.
 *
 * This runs the *same* `listItemToAgendaItem` the fetcher runs, over the same shape the fetcher
 * receives, so the result is what a refetch would have produced rather than an approximation.
 * That only holds because the reminders fetch is uncapped — it maps every item on the dashboard,
 * so removing or rewriting one entry can never reveal an item the client does not already hold.
 *
 * Entries both leave and arrive this way. Setting a due date makes `listItemToAgendaItem` return
 * an entry where it previously returned null, so the item appears in the agenda from this patch
 * alone; clearing the date or checking the item removes it again. Ordering is not this function's
 * problem — `mergeAgendaState` sorts the merged list on every read, so appending is enough.
 */
export function applyAgendaItemUpdate(
  dashboardId: string,
  item: ListItem,
  list: Pick<ListSummary, 'id' | 'name'>,
): void {
  const next = listItemToAgendaItem(item, list, dateKey(startOfDay(new Date())))
  const entryId = `reminder:${item.id}`

  agendaRemindersQuery.updateWhere(
    (scope) => scope.dashboardId === dashboardId,
    (state) => {
      if (!state.data) return state
      const without = state.data.filter((entry) => entry.id !== entryId)
      return { ...state, data: next ? [...without, next] : without }
    },
  )
}

/** Drop agenda entries whose items no longer exist.
 *
 * Deliberately unscoped: reminder entry ids are `reminder:<itemId>` and an item belongs to exactly
 * one list, which belongs to exactly one dashboard, so a match can only occur in the one scope
 * that holds it. Sweeping every scope means the caller does not have to know the dashboard — and
 * `deleteList` genuinely does not, since a list can be trashed from the sidebar without its detail
 * ever being loaded.
 */
export function removeAgendaItems(itemIds: string[]): void {
  const doomed = new Set(itemIds.map((id) => `reminder:${id}`))
  agendaRemindersQuery.updateWhere(
    () => true,
    (state) => {
      if (!state.data) return state
      return { ...state, data: state.data.filter((entry) => !doomed.has(entry.id)) }
    },
  )
}

/** Rename a list's agenda entries — each reminder carries its list's name for display. */
export function renameAgendaListEntries(listId: string, listName: string): void {
  agendaRemindersQuery.updateWhere(
    () => true,
    (state) => {
      if (!state.data) return state
      return {
        ...state,
        data: state.data.map((entry) =>
          entry.type === 'reminder' && entry.listId === listId ? { ...entry, listName } : entry,
        ),
      }
    },
  )
}

/** Refetch a dashboard's reminders — the one list mutation whose result cannot be derived.
 *
 * Restoring a list returns a summary, not its items, so there is nothing to rebuild reminders
 * from. The sanctioned kind of refetch: the client provably lacks the data.
 */
export function invalidateAgendaReminders(dashboardId: string): void {
  agendaRemindersQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
}

/** Drop every agenda entry belonging to a list, for a list that was trashed or deleted. */
export function removeAgendaItemsForList(listId: string): void {
  agendaRemindersQuery.updateWhere(
    () => true,
    (state) => {
      if (!state.data) return state
      return {
        ...state,
        data: state.data.filter((entry) => entry.type !== 'reminder' || entry.listId !== listId),
      }
    },
  )
}

async function fetchAgendaReminders(scope: AgendaScope): Promise<AgendaItem[]> {
  const todayKey = dateKey(startOfDay(new Date()))
  // One batch request rather than one per list, and it reads no client cache — which is what
  // keeps handler order in useSSE from mattering.
  const details = await apiGetListDetails(scope.dashboardId)

  return details.flatMap((detail) =>
    detail.items
      .map((item) => listItemToAgendaItem(item, detail, todayKey))
      .filter((item): item is AgendaItem => item !== null),
  )
}

function mergeAgendaState(
  occurrences: CalendarOccurrence[] | null,
  remindersState: ScopedQueryState<AgendaItem[]>,
  occurrencesLoading: boolean,
  occurrencesError: Error | null,
): ScopedQueryState<AgendaItem[]> {
  const data =
    occurrences && remindersState.data
      ? [...remindersState.data, ...occurrences.map(occurrenceToAgendaItem)].sort(
          compareAgendaItems,
        )
      : null

  return {
    data,
    loading: occurrencesLoading || remindersState.loading,
    error: occurrencesError ?? remindersState.error,
  }
}

export function useAgendaItems(dashboardId: string | null) {
  const scope = useMemo<AgendaScope | null>(
    () => (dashboardId ? { dashboardId } : null),
    [dashboardId],
  )

  // At local midnight the window and the today/overdue classification both go stale. The window is
  // derived from today so the occurrence store refetches on its own; reminders classify at fetch
  // time, so they still need the explicit nudge. The ref skips the mount run.
  const today = useLocalToday()
  const agendaWindow = useMemo(
    () => ({ start: today.toISOString(), end: addDays(today, 8).toISOString() }),
    [today],
  )
  const previousDay = useRef(today)
  useEffect(() => {
    if (previousDay.current === today) return
    previousDay.current = today
    if (!scope) return
    void agendaRemindersQuery.fetch(scope, { background: true }).catch(() => undefined)
  }, [today, scope])

  const occurrences = useOccurrences(dashboardId, agendaWindow.start, agendaWindow.end)
  const remindersState = agendaRemindersQuery.useQuery(scope)

  return useMemo(
    () => ({
      ...mergeAgendaState(
        occurrences.loaded ? occurrences.data : null,
        remindersState,
        occurrences.loading,
        occurrences.error,
      ),
      // Retry both halves: either one failing surfaces as the merged error.
      refetch: () => {
        occurrences.refetch()
        remindersState.refetch()
      },
    }),
    [occurrences, remindersState],
  )
}

export function handleAgendaResourceEvent(
  event: ResourceEvent,
  { isOwnEcho = false }: { isOwnEcho?: boolean } = {},
): void {
  if (event.event_type === 'resync') {
    agendaRemindersQuery.invalidateWhere(() => true)
    return
  }

  // Own echoes have nothing to add: `applyAgendaItemUpdate` already patched list reminders, and
  // a calendar mutation's own path refetched the shared occurrence store after its commit.
  if (isOwnEcho) return

  const dashboardId = getDashboardId(event)
  const invalidateMatching = (invalidate: (predicate: (scope: AgendaScope) => boolean) => void) => {
    if (dashboardId) {
      invalidate((scope) => scope.dashboardId === dashboardId)
    } else {
      invalidate(() => true)
    }
  }

  // Calendar events reach the shared occurrence store through handleCalendarResourceEvent.
  if (event.event_type.startsWith('list.')) {
    invalidateMatching((predicate) => agendaRemindersQuery.invalidateWhere(predicate))
  }
}

export function resetAgendaData(): void {
  agendaRemindersQuery.reset()
  resetOccurrences()
}

registerResourceReset(resetAgendaData)
