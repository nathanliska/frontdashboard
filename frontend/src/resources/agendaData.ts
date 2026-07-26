import { useEffect, useMemo, useRef } from 'react'
import type { CalendarOccurrence } from '../api/calendar'
import { apiListOccurrences } from '../api/calendar'
import type { ListItem, ListSummary } from '../api/lists'
import { useLocalDay } from '../hooks/useLocalDay'
import type { ResourceEvent, SseEvent } from '../hooks/useSSE'
import { addDays, dateKey, startOfDay } from '../utils/calendar/calendarUtils'
import { loadDashboardListDetails } from './listData'
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
// the calendar slice. List reminders are still included on agenda load, but
// list events are handled by the list resource layer instead of this module.
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

  // At local midnight the cached fetch window and today/overdue classification go stale. Refetch
  // this mounted agenda in the background (rather than salting the cache key with the day, which
  // would leak a new entry every day). A direct fetch, not invalidateWhere: we hold the mounted
  // scope and want exactly it refreshed, without depending on listener-timing during this render.
  // The ref skips the mount run — only a real day rollover refetches.
  const dayKey = useLocalDay()
  const previousDay = useRef(dayKey)
  useEffect(() => {
    if (previousDay.current === dayKey) return
    previousDay.current = dayKey
    if (!scope) return
    void agendaOccurrencesQuery.fetch(scope, { background: true }).catch(() => undefined)
    void agendaRemindersQuery.fetch(scope, { background: true }).catch(() => undefined)
  }, [dayKey, scope])

  const occurrencesState = agendaOccurrencesQuery.useQuery(scope)
  const remindersState = agendaRemindersQuery.useQuery(scope)

  return useMemo(
    () => ({
      ...mergeAgendaState(occurrencesState, remindersState),
      // Retry both halves: either one failing surfaces as the merged error.
      refetch: () => {
        occurrencesState.refetch()
        remindersState.refetch()
      },
    }),
    [occurrencesState, remindersState],
  )
}

export function handleAgendaResourceEvent(event: ResourceEvent): void {
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
  }

  if (event.event_type.startsWith('list.')) {
    invalidateMatching((predicate) => agendaRemindersQuery.invalidateWhere(predicate))
  }
}

export function resetAgendaData(): void {
  agendaOccurrencesQuery.reset()
  agendaRemindersQuery.reset()
}
