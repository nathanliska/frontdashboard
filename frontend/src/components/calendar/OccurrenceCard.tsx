import { Clock3, MapPin, Pencil, Repeat2, Trash2 } from 'lucide-react'
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
    <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-zinc-100">{occurrence.title}</h3>
            {occurrence.recurring && <EventBadge>Recurring</EventBadge>}
            {occurrence.is_exception && <EventBadge>Exception</EventBadge>}
            {isMultiDayOccurrence(occurrence) && <EventBadge>Multi-day</EventBadge>}
            <ParticipantDots participants={occurrence.participants} />
          </div>
          <div className="mt-2 flex flex-col gap-1.5 text-sm text-zinc-400">
            <div className="flex items-center gap-2">
              <Clock3 size={14} className="text-zinc-600" />
              <span>
                {formatOccurrenceSpan(
                  occurrence.occurrence_start,
                  occurrence.occurrence_end,
                  occurrence.all_day,
                )}
              </span>
            </div>
            {occurrence.location && (
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-zinc-600" />
                <span>{occurrence.location}</span>
              </div>
            )}
            {occurrence.recurring && (
              <div className="flex items-center gap-2">
                <Repeat2 size={14} className="text-zinc-600" />
                <span>Series event</span>
              </div>
            )}
          </div>
          {occurrence.description && (
            <p className="mt-3 text-sm text-zinc-500 whitespace-pre-wrap">
              {occurrence.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
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
