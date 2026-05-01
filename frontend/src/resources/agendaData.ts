import { useMemo } from 'react'
import type { CalendarOccurrence } from '../api/calendar'
import { apiListOccurrences } from '../api/calendar'
import type { ListItem, ListSummary } from '../api/lists'
import { apiGetList, apiGetLists } from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { addDays, dateKey, startOfDay } from '../utils/calendar/calendarUtils'
import { createScopedQuery } from './scopedQuery'

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

const agendaQuery = createScopedQuery<AgendaScope, AgendaItem[]>({
  getKey: (scope) => scope.dashboardId,
  fetcher: fetchAgendaItems,
  fallbackErrorMessage: 'Failed to load agenda.',
})

function getEventPayload(event: SseEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === 'object' ? event.payload : null
}

function getDashboardId(event: SseEvent): string | null {
  const payload = getEventPayload(event)
  return typeof payload?.dashboard_id === 'string' ? payload.dashboard_id : null
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

async function fetchAgendaItems(scope: AgendaScope): Promise<AgendaItem[]> {
  const today = startOfDay(new Date())
  const todayKey = dateKey(today)
  const windowEnd = addDays(today, 8)

  const [occurrences, lists] = await Promise.all([
    apiListOccurrences({
      windowStart: today.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dashboardId: scope.dashboardId,
    }),
    apiGetLists(scope.dashboardId),
  ])

  const activeLists = lists.filter((list) => !list.archived)
  const details = await Promise.all(activeLists.map((list) => apiGetList(list.id)))
  const reminders = details.flatMap((detail) =>
    detail.items
      .map((item) => listItemToAgendaItem(item, detail, todayKey))
      .filter((item): item is AgendaItem => item !== null),
  )

  return [...reminders, ...occurrences.map(occurrenceToAgendaItem)].sort(compareAgendaItems)
}

export function useAgendaItems(dashboardId: string | null) {
  const scope = useMemo<AgendaScope | null>(
    () => (dashboardId ? { dashboardId } : null),
    [dashboardId],
  )
  return agendaQuery.useQuery(scope)
}

export function handleAgendaResourceEvent(event: SseEvent): void {
  if (event.event_type === 'resync') {
    agendaQuery.invalidateWhere(() => true)
    return
  }

  if (event.event_type.startsWith('calendar.') || event.event_type.startsWith('list.')) {
    const dashboardId = getDashboardId(event)
    if (dashboardId) {
      agendaQuery.invalidateWhere((scope) => scope.dashboardId === dashboardId)
    } else {
      agendaQuery.invalidateWhere(() => true)
    }
  }
}

export function resetAgendaData(): void {
  agendaQuery.reset()
}
