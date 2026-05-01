import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarOccurrence } from '../../../api/calendar'
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
  const occurrences = occurrencesQuery.data ?? EMPTY_OCCURRENCES
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
