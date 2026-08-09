import { CalendarDays, Clock3 } from 'lucide-react'
import { memo } from 'react'
import type { CalendarOccurrence } from '../../../api/calendar'
import {
  CALENDAR_WEEKDAY_LABELS,
  CALENDAR_WEEKDAY_LABELS_COMPACT,
  dateKey,
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
  formatDayNumber,
  formatMonthLabel,
  formatOccurrenceSpan,
  formatOccurrenceTime,
  isMultiDayOccurrence,
} from '../../../utils/calendar/calendarUtils'
import { cn } from '../../../utils/shared/cn'
import { CalendarDayNumber } from '../../calendar/CalendarDayNumber'
import { ParticipantDots, ParticipantMicroDots } from '../../calendar/ParticipantDots'
import { type CalendarWidgetView, ViewTabButtons } from './CalendarWidgetViewTabs'

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export const DayCalendarWidget = memo(function DayCalendarWidget({
  occurrences,
  day,
}: {
  occurrences: CalendarOccurrence[]
  day: Date
}) {
  return (
    <div className="h-full flex flex-col gap-3">
      <div className="shrink-0">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Today</p>
        <p className="text-sm font-medium text-zinc-100">
          {new Intl.DateTimeFormat(undefined, {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          }).format(day)}
        </p>
      </div>

      {occurrences.length === 0 ? (
        <EmptyState message="No events today." />
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {occurrences.map((occurrence) => (
            <article
              key={`${occurrence.event_id}:${occurrence.original_start}`}
              className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-1.5">
                <p className="text-xs font-medium text-zinc-100 truncate">{occurrence.title}</p>
                <ParticipantDots participants={occurrence.participants} size="xs" />
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                <Clock3 size={11} className="shrink-0" />
                <span className="truncate">
                  {isMultiDayOccurrence(occurrence)
                    ? formatOccurrenceSpan(
                        occurrence.occurrence_start,
                        occurrence.occurrence_end,
                        occurrence.all_day,
                      )
                    : formatOccurrenceTime(
                        occurrence.occurrence_start,
                        occurrence.occurrence_end,
                        occurrence.all_day,
                      )}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
})

export const WeekCalendarWidget = memo(function WeekCalendarWidget({
  days,
  occurrencesByDate,
  compact,
}: {
  days: Date[]
  occurrencesByDate: Map<string, CalendarOccurrence[]>
  compact: boolean
}) {
  return (
    <div className="h-full flex flex-col gap-2">
      <div className="shrink-0">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">This week</p>
      </div>

      <div className="grid grid-cols-7 gap-1 flex-1 min-h-0">
        {days.map((day) => {
          const dayOccurrences = occurrencesByDate.get(dateKey(day)) ?? []
          const isToday = dateKey(day) === dateKey(new Date())

          return (
            <div
              key={day.toISOString()}
              className={cn(
                'rounded-lg border border-zinc-800 bg-zinc-950/60 p-1.5 min-h-0 min-w-0 overflow-hidden',
                isToday && 'border-zinc-600 bg-zinc-900',
              )}
            >
              <div className="flex items-center justify-between gap-1 mb-1">
                <span className="text-[10px] uppercase text-zinc-500">
                  {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}
                </span>
                <span className={cn('text-[11px]', isToday ? 'text-zinc-100' : 'text-zinc-400')}>
                  {formatDayNumber(day)}
                </span>
              </div>
              <div className="space-y-1">
                {dayOccurrences.slice(0, compact ? 2 : 3).map((occurrence) => (
                  <div
                    key={`${occurrence.event_id}:${occurrence.original_start}`}
                    title={formatCalendarOccurrenceCellTitle(occurrence, day)}
                    className={cn(
                      'flex items-center gap-1 rounded px-1.5 py-1 text-[10px] leading-tight',
                      occurrence.recurring
                        ? 'bg-emerald-500/12 text-emerald-300'
                        : 'bg-sky-500/12 text-sky-300',
                    )}
                  >
                    <ParticipantMicroDots participants={occurrence.participants} />
                    <span className="min-w-0 truncate">
                      {compact
                        ? occurrence.title
                        : formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
                    </span>
                  </div>
                ))}
                {dayOccurrences.length > (compact ? 2 : 3) && (
                  <p className="text-[10px] text-zinc-500">
                    +{dayOccurrences.length - (compact ? 2 : 3)}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

export const MonthCalendarWidget = memo(function MonthCalendarWidget({
  days,
  occurrencesByDate,
  compact,
  ultraCompact,
  monthDate,
  view,
  viewCompact,
  onViewChange,
}: {
  days: Date[]
  occurrencesByDate: Map<string, CalendarOccurrence[]>
  compact: boolean
  ultraCompact: boolean
  monthDate: Date
  view: CalendarWidgetView
  viewCompact: boolean
  onViewChange: (value: CalendarWidgetView) => void | Promise<void>
}) {
  const weekdayLabels = compact ? CALENDAR_WEEKDAY_LABELS_COMPACT : CALENDAR_WEEKDAY_LABELS

  return (
    <div className="h-full flex flex-col">
      <div
        className={cn(
          'shrink-0 flex flex-wrap items-center justify-between gap-2',
          ultraCompact ? 'mb-1' : 'mb-2',
        )}
      >
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          {formatMonthLabel(monthDate)}
        </p>
        <div className="flex items-center gap-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">View</p>
          <ViewTabButtons compact={viewCompact} value={view} onChange={onViewChange} />
        </div>
      </div>

      <div
        className={cn(
          'grid grid-cols-7 text-[10px] text-zinc-500',
          ultraCompact ? 'gap-0.5 mb-0.5' : 'gap-1 mb-1',
        )}
      >
        {weekdayLabels.map((label, index) => (
          <div key={WEEKDAY_KEYS[index]} className="min-w-0 text-center">
            {label}
          </div>
        ))}
      </div>

      <div
        className={cn(
          'grid grid-cols-7 auto-rows-fr flex-1 min-h-0',
          ultraCompact ? 'gap-0.5' : 'gap-1',
        )}
      >
        {days.map((day) => {
          const dayOccurrences = occurrencesByDate.get(dateKey(day)) ?? []
          const inMonth = day.getMonth() === monthDate.getMonth()
          const isToday = dateKey(day) === dateKey(new Date())
          const visible = dayOccurrences.slice(0, compact ? 1 : 2)

          return (
            <div
              key={day.toISOString()}
              className={cn(
                ultraCompact
                  ? 'rounded border border-zinc-800 bg-zinc-950/60 p-0.5 min-h-0 min-w-0 overflow-hidden'
                  : 'rounded-md border border-zinc-800 bg-zinc-950/60 p-1 min-h-0 min-w-0 overflow-hidden flex flex-col',
                !inMonth && 'opacity-45',
                isToday && 'border-zinc-600 bg-zinc-900',
              )}
            >
              <div className={cn(ultraCompact ? 'mb-0.5' : 'mb-1 shrink-0')}>
                <CalendarDayNumber
                  value={formatDayNumber(day)}
                  isToday={isToday}
                  dimmed={!inMonth}
                  compact={ultraCompact}
                />
              </div>
              {ultraCompact ? (
                <div className="flex items-center gap-0.5">
                  {dayOccurrences.slice(0, 2).map((occurrence) => (
                    <span
                      key={`${occurrence.event_id}:${occurrence.original_start}`}
                      title={formatCalendarOccurrenceCellTitle(occurrence, day)}
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        occurrence.recurring ? 'bg-emerald-300' : 'bg-sky-300',
                      )}
                    />
                  ))}
                  {dayOccurrences.length > 2 && (
                    <span className="text-[8px] text-zinc-500">+{dayOccurrences.length - 2}</span>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex-1 min-h-0 overflow-hidden space-y-1">
                    {visible.map((occurrence) => (
                      <div
                        key={`${occurrence.event_id}:${occurrence.original_start}`}
                        title={formatCalendarOccurrenceCellTitle(occurrence, day)}
                        className={cn(
                          'flex items-center gap-1 rounded px-1 py-0.5 text-[10px]',
                          occurrence.recurring
                            ? 'bg-emerald-500/12 text-emerald-300'
                            : 'bg-sky-500/12 text-sky-300',
                        )}
                      >
                        <ParticipantMicroDots participants={occurrence.participants} />
                        <span className="min-w-0 truncate">
                          {formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
                        </span>
                      </div>
                    ))}
                  </div>
                  {dayOccurrences.length > visible.length && (
                    <p className="text-[10px] text-zinc-500 shrink-0 mt-0.5">
                      +{dayOccurrences.length - visible.length}
                    </p>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
      <CalendarDays size={18} className="text-zinc-700" />
      <p className="text-xs text-zinc-600">{message}</p>
    </div>
  )
}
