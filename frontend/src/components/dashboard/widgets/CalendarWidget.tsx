import { useCallback, useMemo } from 'react'
import type { CalendarOccurrence } from '../../../api/calendar'
import type { CalendarWidgetConfig } from '../../../api/dashboards'
import { useContainerSize } from '../../../hooks/useContainerSize'
import { useLocalDay } from '../../../hooks/useLocalDay'
import { useCalendarOccurrences } from '../../../resources/calendarData'
import { useDashboardStore } from '../../../stores/dashboard'
import {
  addDays,
  calendarWindow,
  dateKey,
  monthWeeksInView,
  occurrencesForDate,
  startOfDay,
  startOfWeek,
} from '../../../utils/calendar/calendarUtils'
import { WidgetErrorState } from '../WidgetErrorState'
import { DayCalendarWidget, MonthCalendarWidget, WeekCalendarWidget } from './CalendarWidgetViews'
import { type CalendarWidgetView, WidgetViewTabs } from './CalendarWidgetViewTabs'

const EMPTY_OCCURRENCES: CalendarOccurrence[] = []

export function CalendarWidget({
  widgetId,
  dashboardId,
  config,
}: {
  widgetId: string
  dashboardId: string
  config: CalendarWidgetConfig
}) {
  // Measured rather than queried in CSS: these feed how many occurrences a cell renders and which
  // weekday labels it uses, neither of which a container query can decide.
  const [containerRef, { width: containerWidth, height: containerHeight }] = useContainerSize({
    width: 300,
    height: 320,
  })
  const updateWidget = useDashboardStore((s) => s.updateWidget)

  // `view` is a plain string in the contract, not a Literal union: it is read back from
  // persisted config, so an unrecognized stored value must degrade to 'month', not 500/throw.
  const requestedView = config.view
  const view: CalendarWidgetView =
    requestedView === 'day' || requestedView === 'week' ? requestedView : 'month'
  const dayKey = useLocalDay()
  // biome-ignore lint/correctness/useExhaustiveDependencies: dayKey re-runs `new Date()` at the local-day rollover — an intentional trigger dep, not used inside.
  const today = useMemo(() => startOfDay(new Date()), [dayKey])
  const ultraCompactMonth = view === 'month' && containerWidth < 280
  const widgetWindow = useMemo(() => getWidgetWindow(view, today), [today, view])
  const occurrencesQuery = useCalendarOccurrences(
    widgetWindow.windowStart.toISOString(),
    widgetWindow.windowEnd.toISOString(),
    dashboardId,
  )
  const occurrences = occurrencesQuery.data ?? EMPTY_OCCURRENCES
  const { loading, error } = occurrencesQuery

  const weekDays = useMemo(() => {
    const start = startOfWeek(today)
    return Array.from({ length: 7 }, (_, index) => addDays(start, index))
  }, [today])
  const monthDays = useMemo(() => monthWeeksInView(today), [today])
  const visibleOccurrencesByDate = useMemo(() => {
    const days = view === 'day' ? [today] : view === 'week' ? weekDays : monthDays
    return new Map(days.map((day) => [dateKey(day), occurrencesForDate(occurrences, day)]))
  }, [monthDays, occurrences, today, view, weekDays])

  const handleViewChange = useCallback(
    async (nextView: CalendarWidgetView) => {
      if (nextView === view) return
      await updateWidget(widgetId, {
        ...config,
        view: nextView,
      })
    },
    [config, updateWidget, view, widgetId],
  )

  if (error) {
    return (
      <WidgetErrorState
        title="Calendar unavailable"
        detail="Could not load scheduled events."
        onRetry={occurrencesQuery.refetch}
      />
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
          <DayCalendarWidget
            occurrences={visibleOccurrencesByDate.get(dateKey(today)) ?? []}
            day={today}
          />
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
            occurrencesByDate={visibleOccurrencesByDate}
            compact={containerWidth < 320 || containerHeight < 260}
          />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col gap-3">
      <div className="flex-1 min-h-0">
        <MonthCalendarWidget
          days={monthDays}
          occurrencesByDate={visibleOccurrencesByDate}
          compact={containerWidth < 340 || containerHeight < 280}
          ultraCompact={ultraCompactMonth}
          monthDate={today}
          view={view}
          viewCompact={containerWidth < 260}
          onViewChange={handleViewChange}
        />
      </div>
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
