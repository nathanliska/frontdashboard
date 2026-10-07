import { CalendarDays, Clock3 } from 'lucide-react'
import { memo } from 'react'
import { Link } from 'react-router'
import type { CalendarOccurrence } from '../../../api/calendar'
import { useContainerSize } from '../../../hooks/useContainerSize'
import { ROUTES } from '../../../routes'
import {
  CALENDAR_WEEKDAY_LABELS,
  CALENDAR_WEEKDAY_LABELS_COMPACT,
  dateKey,
  formatCalendarOccurrenceCellTitle,
  formatDayNumber,
  formatEventCount,
  formatHeadingDate,
  formatMonthLabel,
  formatOccurrenceSpan,
} from '../../../utils/calendar/calendarUtils'
import { cn } from '../../../utils/shared/cn'
import {
  CalendarDayNumber,
  DAY_NUMBER_HEIGHT,
  FULL_DAY_NUMBER_MIN_WIDTH,
} from '../../calendar/CalendarDayNumber'
import {
  CalendarDayOccurrences,
  DAY_HEADING_GAP,
  hiddenOccurrencesTitle,
  MONTH_PILL_HEIGHT,
  occurrenceDot,
  occurrenceTint,
} from '../../calendar/CalendarDayOccurrences'
import { ParticipantDots } from '../../calendar/ParticipantDots'
import { type CalendarWidgetView, ViewTabButtons } from './CalendarWidgetViewTabs'

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const WEEKDAY_NARROW = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })

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
                  {formatOccurrenceSpan(
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
  dashboardId,
  days,
  occurrencesByDate,
}: {
  dashboardId: string
  days: Date[]
  occurrencesByDate: Map<string, CalendarOccurrence[]>
}) {
  // Measured because CSS cannot count rows, and one cell answers for all seven: they share a grid
  // row, so the body of the first is the height of every other.
  const [cellBodyRef, cellBody] = useContainerSize({ width: 0, height: 200 })

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="shrink-0">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">This week</p>
      </div>

      <div className="grid grid-cols-7 gap-1 flex-1 min-h-0">
        {days.map((day, index) => {
          const dayOccurrences = occurrencesByDate.get(dateKey(day)) ?? []
          const isToday = dateKey(day) === dateKey(new Date())

          return (
            <Link
              key={day.toISOString()}
              to={`${ROUTES.calendar}?${new URLSearchParams({ dashboard_id: dashboardId, date: dateKey(day) })}`}
              aria-label={`${formatHeadingDate(day)}: ${formatEventCount(dayOccurrences.length)}. Open day`}
              className={cn(
                '@container rounded-lg border border-zinc-800 bg-zinc-950/60 p-1.5 min-h-0 min-w-0 overflow-hidden flex flex-col focus-visible:outline-2 focus-visible:outline-sky-400',
                isToday && 'border-zinc-600 bg-zinc-900',
              )}
            >
              <CalendarDayOccurrences
                heading={
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
                    {/* Three letters, a date and a "+N" need ~52px; one letter needs ~40px; below
                        that the date alone carries the day, and the link's label names it. */}
                    <span className="min-w-0 truncate text-[10px] uppercase text-zinc-500">
                      <span className="@max-[52px]:hidden">{WEEKDAY_SHORT.format(day)}</span>
                      <span className="hidden @min-[40px]:@max-[52px]:inline">
                        {WEEKDAY_NARROW.format(day)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-[11px]',
                        isToday ? 'text-zinc-100' : 'text-zinc-400',
                      )}
                    >
                      {formatDayNumber(day)}
                    </span>
                  </div>
                }
                occurrences={dayOccurrences}
                day={day}
                height={cellBody.height}
                density="week"
                measureRef={index === 0 ? cellBodyRef : null}
              />
            </Link>
          )
        })}
      </div>
    </div>
  )
})

/** Mirrors `gap-1` on the month's day grid, and `gap-0.5` when `tight`. */
const MONTH_GRID_GAP = { roomy: 4, tight: 2 } as const
/** A month cell's border and `p-1`, on each axis. */
const MONTH_CELL_FRAME = 2 + 8
/** What a month cell spends besides its date and pills: its frame, then the heading gap. */
const MONTH_CELL_CHROME = MONTH_CELL_FRAME + DAY_HEADING_GAP

export type MonthCellLayout = 'full' | 'compact' | 'line'

/**
 * How a month cell `cellHeight` pixels tall lays out: the full date over pills, the compact date
 * over pills, or — too short for any pill under a date — one line of date, first title and "+N".
 */
export function monthCellLayout(cellHeight: number): MonthCellLayout {
  const room = cellHeight - MONTH_CELL_CHROME - MONTH_PILL_HEIGHT
  if (room >= DAY_NUMBER_HEIGHT.full) return 'full'
  if (room >= DAY_NUMBER_HEIGHT.compact) return 'compact'
  return 'line'
}

export const MonthCalendarWidget = memo(function MonthCalendarWidget({
  dashboardId,
  days,
  occurrencesByDate,
  compact,
  tight,
  monthDate,
  view,
  viewCompact,
  onViewChange,
}: {
  dashboardId: string
  days: Date[]
  occurrencesByDate: Map<string, CalendarOccurrence[]>
  compact: boolean
  /** Tighter spacing around the grid, decided by the widget's size rather than the grid's. */
  tight: boolean
  monthDate: Date
  view: CalendarWidgetView
  viewCompact: boolean
  onViewChange: (value: CalendarWidgetView) => void | Promise<void>
}) {
  const weekdayLabels = compact ? CALENDAR_WEEKDAY_LABELS_COMPACT : CALENDAR_WEEKDAY_LABELS
  // Measured because CSS cannot count rows. The grid rather than a cell: its size is set by the
  // widget and `tight`, never by what the cells hold, so the layout it picks cannot change the
  // measurement that picked it — and equal fractional tracks make every cell's size derivable.
  const [gridRef, grid] = useContainerSize({ width: 0, height: 400 })
  const rows = Math.ceil(days.length / 7)
  const gap = MONTH_GRID_GAP[tight ? 'tight' : 'roomy']
  const cellHeight = (grid.height - gap * (rows - 1)) / rows
  const layout = monthCellLayout(cellHeight)
  const oneLine = layout === 'line'
  // Zero until measured, but the grid is invisible until then, so no layout chosen from it shows.
  const bodyWidth = Math.max(0, (grid.width - gap * 6) / 7 - MONTH_CELL_FRAME)
  const compactDate = layout === 'compact' || bodyWidth < FULL_DAY_NUMBER_MIN_WIDTH
  const bodyHeight =
    cellHeight - MONTH_CELL_CHROME - DAY_NUMBER_HEIGHT[compactDate ? 'compact' : 'full']

  return (
    <div className="h-full flex flex-col">
      {/* Margins fixed, so `tight` moves only the gaps inside the grid and never the grid's own
          height — the measurement the layout is chosen from is never one spacing out of date. */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 mb-1">
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
          'grid grid-cols-7 mb-0.5 text-[10px] text-zinc-500',
          tight ? 'gap-0.5' : 'gap-1',
        )}
      >
        {weekdayLabels.map((label, index) => (
          <div key={WEEKDAY_KEYS[index]} className="min-w-0 text-center">
            {label}
          </div>
        ))}
      </div>

      <div
        ref={gridRef}
        className={cn(
          'grid grid-cols-7 auto-rows-fr flex-1 min-h-0',
          tight ? 'gap-0.5' : 'gap-1',
          // Unmeasured, the layout is a guess; showing it flashes the wrong one for a frame.
          grid.width === 0 && 'invisible',
        )}
      >
        {days.map((day) => {
          const dayOccurrences = occurrencesByDate.get(dateKey(day)) ?? []
          const inMonth = day.getMonth() === monthDate.getMonth()
          const isToday = dateKey(day) === dateKey(new Date())
          const dayNumber = (
            <CalendarDayNumber
              value={formatDayNumber(day)}
              isToday={isToday}
              dimmed={!inMonth}
              compact={oneLine || compactDate}
            />
          )

          return (
            <Link
              key={day.toISOString()}
              to={`${ROUTES.calendar}?${new URLSearchParams({ dashboard_id: dashboardId, date: dateKey(day) })}`}
              aria-label={`${formatHeadingDate(day)}: ${formatEventCount(dayOccurrences.length)}. Open day`}
              className={cn(
                'border border-zinc-800 bg-zinc-950/60 min-h-0 min-w-0 overflow-hidden flex focus-visible:outline-2 focus-visible:outline-sky-400',
                oneLine
                  ? 'rounded px-0.5 items-center justify-between gap-0.5'
                  : 'rounded-md p-1 flex-col',
                !inMonth && 'opacity-45',
                isToday && 'border-zinc-600 bg-zinc-900',
              )}
            >
              {oneLine ? (
                <>
                  <div className="flex shrink-0">{dayNumber}</div>
                  <div className="@container flex min-w-0 flex-1 items-center gap-0.5">
                    {dayOccurrences[0] && (
                      <>
                        <span
                          title={formatCalendarOccurrenceCellTitle(dayOccurrences[0], day)}
                          className={cn(
                            'flex min-w-0 flex-1 rounded px-0.5 text-[9px] leading-3 @max-[36px]:hidden',
                            occurrenceTint(dayOccurrences[0]),
                          )}
                        >
                          <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap fade-end">
                            {dayOccurrences[0].title}
                          </span>
                        </span>
                        {/* Too narrow for a title beside the date and "+N", a dot says there is one. */}
                        <span
                          className={cn(
                            'hidden h-1.5 w-1.5 shrink-0 rounded-full @max-[36px]:block',
                            occurrenceDot(dayOccurrences[0]),
                          )}
                        />
                      </>
                    )}
                    {dayOccurrences.length > 1 && (
                      <span
                        className="shrink-0 text-[8px] text-zinc-400"
                        title={hiddenOccurrencesTitle(dayOccurrences.slice(1), day)}
                      >
                        +{dayOccurrences.length - 1}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <CalendarDayOccurrences
                  heading={dayNumber}
                  occurrences={dayOccurrences}
                  day={day}
                  height={bodyHeight}
                  density="month"
                />
              )}
            </Link>
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
