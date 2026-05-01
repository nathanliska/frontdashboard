import { AlertCircle, CalendarDays, CheckCircle2, Clock3, Repeat2 } from 'lucide-react'
import type { AgendaItem } from '../../../resources/agendaData'
import { useAgendaItems } from '../../../resources/agendaData'
import { dateKey, formatOccurrenceTime } from '../../../utils/calendar/calendarUtils'
import { cn } from '../../../utils/shared/cn'

const MAX_ITEMS = 10

function isToday(item: AgendaItem): boolean {
  const todayKey = dateKey(new Date())
  if (item.type === 'reminder') return item.dueDate <= todayKey
  return dateKey(item.startsAt) === todayKey
}

export function AgendaWidget({ dashboardId }: { dashboardId: string }) {
  const { data, loading, error } = useAgendaItems(dashboardId)
  const all = data ?? []
  const todayItems = all.filter(isToday)
  const upcomingItems = all.filter((i) => !isToday(i)).slice(0, MAX_ITEMS - todayItems.length)

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1">
        <p className="text-xs text-zinc-600">Agenda unavailable</p>
        <p className="text-[10px] text-zinc-700">Could not load today&apos;s priorities.</p>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border border-zinc-700 border-t-zinc-500" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="shrink-0">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Today</p>
        <p className="text-sm font-medium text-zinc-100">
          {new Intl.DateTimeFormat(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          }).format(new Date())}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {todayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-2 text-center">
            <CheckCircle2 size={18} className="text-zinc-700" />
            <p className="text-xs text-zinc-600">Nothing today.</p>
          </div>
        ) : (
          todayItems.map((item) => <AgendaRow key={item.id} item={item} />)
        )}

        {upcomingItems.length > 0 && (
          <>
            <p className="pt-1 text-[10px] uppercase tracking-[0.18em] text-zinc-600">Upcoming</p>
            {upcomingItems.map((item) => (
              <AgendaRow key={item.id} item={item} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function AgendaRow({ item }: { item: AgendaItem }) {
  const tone =
    item.type === 'reminder'
      ? item.status === 'overdue'
        ? 'border-red-500/20 bg-red-500/8'
        : 'border-amber-500/20 bg-amber-500/8'
      : 'border-zinc-800 bg-zinc-950/70'

  return (
    <article className={cn('rounded-lg border px-2.5 py-2', tone)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {item.type === 'reminder' ? (
            item.status === 'overdue' ? (
              <AlertCircle size={13} className="text-red-300" />
            ) : (
              <Clock3 size={13} className="text-amber-300" />
            )
          ) : (
            <CalendarDays size={13} className="text-sky-300" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-zinc-100">{item.title}</p>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="truncate">{formatAgendaMeta(item)}</span>
            {item.type === 'event' && item.recurring && (
              <Repeat2 size={10} className="shrink-0 text-emerald-300" />
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function formatAgendaMeta(item: AgendaItem): string {
  if (item.type === 'reminder') {
    return item.status === 'overdue' ? `Overdue · ${item.listName}` : `Due today · ${item.listName}`
  }

  const todayKey = dateKey(new Date())
  const startsKey = dateKey(item.startsAt)
  const dayLabel =
    startsKey === todayKey
      ? 'Today'
      : new Intl.DateTimeFormat(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }).format(new Date(item.startsAt))

  return `${dayLabel} · ${formatOccurrenceTime(item.startsAt, item.endsAt, item.allDay)}`
}
