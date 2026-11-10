import { useCallback, useMemo } from 'react'
import type { CalendarOccurrence } from '../../../api/calendar'
import type { CalendarWidgetConfig } from '../../../api/dashboards'
import { useContainerSize } from '../../../hooks/useContainerSize'
import { useLocalToday } from '../../../hooks/useLocalDay'
import { useCalendarOccurrences } from '../../../resources/calendarData'
import { useDashboardStore } from '../../../stores/dashboard'
import {
  addDays,
  calendarWindow,
  dateKey,
  monthWeeksInView,
  occurrencesForDate,
  startOfWeek,
} from '../../../utils/calendar/calendarUtils'
import { cn } from '../../../utils/shared/cn'
import { WidgetErrorState } from '../WidgetErrorState'
import { DayCalendarWidget, MonthCalendarWidget, WeekCalendarWidget } from './CalendarWidgetViews'
import { type CalendarWidgetView, WidgetViewTabs } from './CalendarWidgetViewTabs'

const EMPTY_OCCURRENCES: CalendarOccurrence[] = []

/** Below this, a month's gaps and cell padding take a share of each day a phone can't spare. */
const MONTH_TIGHT_WIDTH = 460

/** Below this, seven week columns are too narrow to name a weekday or an event, so days stack. */
const WEEK_LIST_WIDTH = 460

export function CalendarWidget({
  widgetId,
  dashboardId,
  config,
}: {
  widgetId: string
  dashboardId: string
  config: CalendarWidgetConfig
}) {
  // Measured rather than queried in CSS: these pick label sets, which a container query cannot,
  // and the month's `tight` spacing, whose gap the month's own layout arithmetic has to know.
  // Zero until measured, so the week can wait rather than paint a frame of the wrong layout; the
  // other views paint the usual size meanwhile.
  const [containerRef, measured] = useContainerSize({ width: 0, height: 0 })
  const containerWidth = measured.width || 300
  const containerHeight = measured.height || 320
  const updateWidget = useDashboardStore((s) => s.updateWidget)

  // `view` is a plain string in the contract, not a Literal union: it is read back from
  // persisted config, so an unrecognized stored value must degrade to 'month', not 500/throw.
  const requestedView = config.view
  const view: CalendarWidgetView =
    requestedView === 'day' || requestedView === 'week' ? requestedView : 'month'
  const today = useLocalToday()
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
      <div ref={containerRef} className="h-full flex flex-col gap-2">
        <WidgetViewTabs
          label="Today"
          compact={containerWidth < 260}
          value={view}
          onChange={handleViewChange}
        />
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
      <div ref={containerRef} className="h-full flex flex-col gap-2">
        <WidgetViewTabs
          label="This week"
          compact={containerWidth < 260}
          value={view}
          onChange={handleViewChange}
        />
        <div className={cn('flex-1 min-h-0', measured.width === 0 && 'invisible')}>
          <WeekCalendarWidget
            dashboardId={dashboardId}
            days={weekDays}
            occurrencesByDate={visibleOccurrencesByDate}
            list={containerWidth < WEEK_LIST_WIDTH}
          />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col gap-3">
      <div className="flex-1 min-h-0">
        <MonthCalendarWidget
          dashboardId={dashboardId}
          days={monthDays}
          occurrencesByDate={visibleOccurrencesByDate}
          compact={containerWidth < 340 || containerHeight < 280}
          // Short, a laptop leaves the rows ~15px and a folded day's line needs every pixel; narrow,
          // a phone's seven columns leave each day under 40px for its titles.
          tight={containerHeight < 320 || containerWidth < MONTH_TIGHT_WIDTH}
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
