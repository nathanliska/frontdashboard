import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Clock3 } from 'lucide-react'
import { type CalendarOccurrence } from '../../../api/calendar'
import { CalendarDayNumber } from '../../calendar/CalendarDayNumber'
import { useCalendarOccurrences } from '../../../resources/calendarData'
import { useDashboardStore } from '../../../stores/dashboard'
import { cn } from '../../../utils/cn'
import {
  CALENDAR_WEEKDAY_LABELS,
  CALENDAR_WEEKDAY_LABELS_COMPACT,
  addDays,
  calendarWindow,
  dateKey,
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
  formatDayNumber,
  formatMonthLabel,
  formatOccurrenceSpan,
  formatOccurrenceTime,
  isMultiDayOccurrence,
  monthGridDays,
  occurrencesForDate,
  startOfDay,
  startOfWeek,
} from '../../../utils/calendar'

type CalendarWidgetView = 'day' | 'week' | 'month'

export function CalendarWidget({
  widgetId,
  dashboardId,
  config,
}: {
  widgetId: string
  dashboardId: string
  config: Record<string, unknown>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(300)
  const [containerHeight, setContainerHeight] = useState(320)
  const updateWidget = useDashboardStore((s) => s.updateWidget)

  const requestedView = typeof config.view === 'string' ? config.view : 'month'
  const view: CalendarWidgetView =
    requestedView === 'day' || requestedView === 'week' ? requestedView : 'month'
  const today = useMemo(() => startOfDay(new Date()), [])
  const ultraCompactMonth = view === 'month' && containerWidth < 280
  const widgetWindow = useMemo(() => getWidgetWindow(view, today), [today, view])
  const occurrencesQuery = useCalendarOccurrences(
    widgetWindow.windowStart.toISOString(),
    widgetWindow.windowEnd.toISOString(),
    dashboardId,
  )
  const occurrences = occurrencesQuery.data ?? []
  const { loading, error } = occurrencesQuery

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width)
      setContainerHeight(entries[0].contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const weekDays = useMemo(() => {
    const start = startOfWeek(today)
    return Array.from({ length: 7 }, (_, index) => addDays(start, index))
  }, [today])
  const monthDays = useMemo(() => monthGridDays(today), [today])

  async function handleViewChange(nextView: CalendarWidgetView) {
    if (nextView === view) return
    await updateWidget(widgetId, {
      ...config,
      view: nextView,
    })
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1">
        <p className="text-xs text-zinc-600">Calendar unavailable</p>
        <p className="text-[10px] text-zinc-700">Could not load scheduled events.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border border-zinc-700 border-t-zinc-500" />
      </div>
    )
  }

  if (view === 'day') {
    return (
      <div ref={containerRef} className="h-full flex flex-col gap-3">
        <WidgetViewTabs compact={containerWidth < 260} value={view} onChange={handleViewChange} />
        <div className="flex-1 min-h-0">
          <DayCalendarWidget occurrences={occurrencesForDate(occurrences, today)} day={today} />
        </div>
      </div>
    )
  }

  if (view === 'week') {
    return (
      <div ref={containerRef} className="h-full flex flex-col gap-3">
        <WidgetViewTabs compact={containerWidth < 260} value={view} onChange={handleViewChange} />
        <div className="flex-1 min-h-0">
          <WeekCalendarWidget
            days={weekDays}
            occurrences={occurrences}
            compact={containerWidth < 320 || containerHeight < 260}
          />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col gap-3">
      <WidgetViewTabs
        compact={containerWidth < 260}
        showLabel={containerWidth >= 320}
        value={view}
        onChange={handleViewChange}
      />
      <div className="flex-1 min-h-0">
        <MonthCalendarWidget
          days={monthDays}
          occurrences={occurrences}
          compact={containerWidth < 340 || containerHeight < 280}
          ultraCompact={ultraCompactMonth}
          monthDate={today}
        />
      </div>
    </div>
  )
}

function WidgetViewTabs({
  compact,
  showLabel = true,
  value,
  onChange,
}: {
  compact: boolean
  showLabel?: boolean
  value: CalendarWidgetView
  onChange: (value: CalendarWidgetView) => void | Promise<void>
}) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-2">
      {showLabel ? (
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">View</p>
      ) : (
        <div />
      )}
      <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
        {(['day', 'week', 'month'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => void onChange(option)}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
              value === option ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200',
            )}
            aria-pressed={value === option}
          >
            {compact ? option[0].toUpperCase() : option[0].toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>
    </div>
  )
}

function DayCalendarWidget({ occurrences, day }: { occurrences: CalendarOccurrence[]; day: Date }) {
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
              <p className="text-xs font-medium text-zinc-100 truncate">{occurrence.title}</p>
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
}

function WeekCalendarWidget({
  days,
  occurrences,
  compact,
}: {
  days: Date[]
  occurrences: CalendarOccurrence[]
  compact: boolean
}) {
  return (
    <div className="h-full flex flex-col gap-2">
      <div className="shrink-0">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">This week</p>
      </div>

      <div className="grid grid-cols-7 gap-1 flex-1 min-h-0">
        {days.map((day) => {
          const dayOccurrences = occurrencesForDate(occurrences, day)
          const isToday = dateKey(day) === dateKey(new Date())

          return (
            <div
              key={day.toISOString()}
              className={cn(
                'rounded-lg border border-zinc-800 bg-zinc-950/60 p-1.5 min-h-0 overflow-hidden',
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
                      'rounded px-1.5 py-1 text-[10px] leading-tight truncate',
                      occurrence.recurring
                        ? 'bg-emerald-500/12 text-emerald-300'
                        : 'bg-sky-500/12 text-sky-300',
                    )}
                  >
                    {compact
                      ? occurrence.title
                      : formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
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
}

function MonthCalendarWidget({
  days,
  occurrences,
  compact,
  ultraCompact,
  monthDate,
}: {
  days: Date[]
  occurrences: CalendarOccurrence[]
  compact: boolean
  ultraCompact: boolean
  monthDate: Date
}) {
  const weekdayLabels = compact ? CALENDAR_WEEKDAY_LABELS_COMPACT : CALENDAR_WEEKDAY_LABELS

  return (
    <div className="h-full flex flex-col">
      <div className={cn('shrink-0', ultraCompact ? 'mb-1' : 'mb-2')}>
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          {formatMonthLabel(monthDate)}
        </p>
      </div>

      <div
        className={cn(
          'grid grid-cols-7 text-[10px] text-zinc-500',
          ultraCompact ? 'gap-0.5 mb-0.5' : 'gap-1 mb-1',
        )}
      >
        {weekdayLabels.map((label, index) => (
          <div key={`${label}-${index}`} className="text-center">
            {label}
          </div>
        ))}
      </div>

      <div className={cn('grid grid-cols-7 flex-1 min-h-0', ultraCompact ? 'gap-0.5' : 'gap-1')}>
        {days.map((day) => {
          const dayOccurrences = occurrencesForDate(occurrences, day)
          const inMonth = day.getMonth() === monthDate.getMonth()
          const isToday = dateKey(day) === dateKey(new Date())
          const visible = dayOccurrences.slice(0, compact ? 1 : 2)

          return (
            <div
              key={day.toISOString()}
              className={cn(
                ultraCompact
                  ? 'rounded border border-zinc-800 bg-zinc-950/60 p-0.5 min-h-0 overflow-hidden'
                  : 'rounded-md border border-zinc-800 bg-zinc-950/60 p-1 min-h-0 overflow-hidden',
                !inMonth && 'opacity-45',
                isToday && 'border-zinc-600 bg-zinc-900',
              )}
            >
              <div className={cn(ultraCompact ? 'mb-0.5' : 'mb-1')}>
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
                <div className="space-y-1">
                  {visible.map((occurrence) => (
                    <div
                      key={`${occurrence.event_id}:${occurrence.original_start}`}
                      title={formatCalendarOccurrenceCellTitle(occurrence, day)}
                      className={cn(
                        'rounded px-1 py-0.5 text-[10px] truncate',
                        occurrence.recurring
                          ? 'bg-emerald-500/12 text-emerald-300'
                          : 'bg-sky-500/12 text-sky-300',
                      )}
                    >
                      {formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
                    </div>
                  ))}
                  {dayOccurrences.length > visible.length && (
                    <p className="text-[10px] text-zinc-500">
                      +{dayOccurrences.length - visible.length}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-center">
      <CalendarDays size={18} className="text-zinc-700" />
      <p className="text-xs text-zinc-600">{message}</p>
    </div>
  )
}

function getWidgetWindow(
  view: CalendarWidgetView,
  today: Date,
): { windowStart: Date; windowEnd: Date } {
  if (view === 'day') {
    return { windowStart: today, windowEnd: addDays(today, 1) }
  }
  if (view === 'week') {
    const weekStart = startOfWeek(today)
    return { windowStart: weekStart, windowEnd: addDays(weekStart, 7) }
  }

  const { start, end } = calendarWindow(today)
  return { windowStart: new Date(start), windowEnd: new Date(end) }
}
