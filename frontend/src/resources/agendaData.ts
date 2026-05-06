import { useMemo } from 'react'
import type { CalendarOccurrence } from '../api/calendar'
import { apiListOccurrences } from '../api/calendar'
import type { ListItem, ListSummary } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { useAuthStore } from '../stores/auth'
import { addDays, dateKey, startOfDay } from '../utils/calendar/calendarUtils'
import { hasPendingListMutation } from '../utils/lists/listMutation'
import { loadDashboardListDetails, readDashboardListDetailsFromCache } from './listData'
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

// Keep mixed-source widgets split at the cache layer so SSE can invalidate only
// the data slice that changed. The agenda UI composes reminders + calendar
// occurrences, but list events should not force a calendar refetch and
// calendar events should not force list-detail reloads.
const agendaOccurrencesQuery = createScopedQuery<AgendaScope, CalendarOccurrence[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: fetchAgendaOccurrences,
  fallbackErrorMessage: 'Failed to load agenda.',
})

const agendaRemindersQuery = createScopedQuery<AgendaScope, AgendaItem[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: fetchAgendaReminders,
  fallbackErrorMessage: 'Failed to load agenda.',
})

function getEventPayload(event: SseEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === 'object' ? event.payload : null
}

function getDashboardId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
}

function getListEventClientMutationId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.client_mutation_id === 'string' ? payload.client_mutation_id : null
}

function isPendingListMutationEcho(event: SseEvent): boolean {
  const currentUserId = useAuthStore.getState().user?.id
  const clientMutationId = getListEventClientMutationId(event)
  if (!currentUserId || event.actor_id !== currentUserId || !clientMutationId) {
    return false
  }

  return hasPendingListMutation(clientMutationId)
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

async function fetchAgendaOccurrences(scope: AgendaScope): Promise<CalendarOccurrence[]> {
  const today = startOfDay(new Date())
  const windowEnd = addDays(today, 8)

  return apiListOccurrences({
    windowStart: today.toISOString(),
    windowEnd: windowEnd.toISOString(),
    dashboardId: scope.dashboardId,
  })
}

async function fetchAgendaReminders(scope: AgendaScope): Promise<AgendaItem[]> {
  const todayKey = dateKey(startOfDay(new Date()))
  const details = await loadDashboardListDetails(scope.dashboardId)

  return details.flatMap((detail) =>
    detail.items
      .map((item) => listItemToAgendaItem(item, detail, todayKey))
      .filter((item): item is AgendaItem => item !== null),
  )
}

function buildAgendaRemindersFromCache(dashboardId: string): AgendaItem[] | null {
  const todayKey = dateKey(startOfDay(new Date()))
  const details = readDashboardListDetailsFromCache(dashboardId)
  if (!details) return null

  return details.flatMap((detail) =>
    detail.items
      .map((item) => listItemToAgendaItem(item, detail, todayKey))
      .filter((agendaItem): agendaItem is AgendaItem => agendaItem !== null),
  )
}

function mergeAgendaState(
  occurrencesState: ScopedQueryState<CalendarOccurrence[]>,
  remindersState: ScopedQueryState<AgendaItem[]>,
): ScopedQueryState<AgendaItem[]> {
  const data =
    occurrencesState.data && remindersState.data
      ? [...remindersState.data, ...occurrencesState.data.map(occurrenceToAgendaItem)].sort(
          compareAgendaItems,
        )
      : null

  return {
    data,
    loading: occurrencesState.loading || remindersState.loading,
    error: occurrencesState.error ?? remindersState.error,
  }
}

export function useAgendaItems(dashboardId: string | null) {
  const scope = useMemo<AgendaScope | null>(
    () => (dashboardId ? { dashboardId } : null),
    [dashboardId],
  )
  const occurrencesState = agendaOccurrencesQuery.useQuery(scope)
  const remindersState = agendaRemindersQuery.useQuery(scope)

  return useMemo(
    () => mergeAgendaState(occurrencesState, remindersState),
    [occurrencesState, remindersState],
  )
}

export function handleAgendaResourceEvent(event: SseEvent): void {
  if (event.event_type === 'resync') {
    agendaOccurrencesQuery.invalidateWhere(() => true)
    agendaRemindersQuery.invalidateWhere(() => true)
    return
  }

  const dashboardId = getDashboardId(event)
  const invalidateMatching = (invalidate: (predicate: (scope: AgendaScope) => boolean) => void) => {
    if (dashboardId) {
      invalidate((scope) => scope.dashboardId === dashboardId)
    } else {
      invalidate(() => true)
    }
  }

  if (event.event_type.startsWith('calendar.')) {
    invalidateMatching((predicate) => agendaOccurrencesQuery.invalidateWhere(predicate))
    return
  }

  if (event.event_type.startsWith('list.')) {
    if (dashboardId && isPendingListMutationEcho(event)) {
      const reminders = buildAgendaRemindersFromCache(dashboardId)
      if (reminders) {
        agendaRemindersQuery.updateWhere(
          (scope) => scope.dashboardId === dashboardId,
          (state) => ({
            data: reminders,
            loading: false,
            error: state.error,
          }),
        )
      }
      return
    }

    // List events only affect reminder rows derived from list items.
    invalidateMatching((predicate) => agendaRemindersQuery.invalidateWhere(predicate))
  }
}

export function resetAgendaData(): void {
  agendaOccurrencesQuery.reset()
  agendaRemindersQuery.reset()
}
