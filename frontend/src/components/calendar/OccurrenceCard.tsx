import { Clock3, MapPin, Pencil, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CalendarOccurrence } from '../../api/calendar'
import { formatOccurrenceSpan, isMultiDayOccurrence } from '../../utils/calendar/calendarUtils'
import { ParticipantDots } from './ParticipantDots'

export function OccurrenceCard({
  occurrence,
  onEdit,
  onDelete,
}: {
  occurrence: CalendarOccurrence
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article className="group rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 sm:px-4 sm:py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-zinc-100">{occurrence.title}</h3>
            {occurrence.recurring && <EventBadge>Recurring</EventBadge>}
            {occurrence.is_exception && <EventBadge>Exception</EventBadge>}
            {isMultiDayOccurrence(occurrence) && <EventBadge>Multi-day</EventBadge>}
            <ParticipantDots participants={occurrence.participants} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Clock3 size={12} className="shrink-0 text-zinc-600" />
              {formatOccurrenceSpan(
                occurrence.occurrence_start,
                occurrence.occurrence_end,
                occurrence.all_day,
              )}
            </span>
            {occurrence.location && (
              <span className="flex min-w-0 items-center gap-1.5">
                <MapPin size={12} className="shrink-0 text-zinc-600" />
                {occurrence.location}
              </span>
            )}
          </div>
          {occurrence.description && (
            <p className="mt-1.5 text-sm text-zinc-500 whitespace-pre-wrap">
              {occurrence.description}
            </p>
          )}
        </div>
        {/* Revealed on hover where there is one; a touch screen has none, so keeps them shown. */}
        <div className="flex items-center gap-1 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg p-2 text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label={occurrence.recurring ? 'Edit series' : 'Edit event'}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-2 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
            aria-label={occurrence.recurring ? 'Delete series' : 'Delete event'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </article>
  )
}

function EventBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
      {children}
    </span>
  )
}
