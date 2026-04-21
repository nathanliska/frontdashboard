import { useState } from 'react'
import type { AddWidgetParams } from '../../../utils/dashboard/widgetCreationTypes'
import { type CalendarWidgetView, ViewTabButtons } from './CalendarWidgetViewTabs'

export function AddWidgetCalendarStep({
  isSharedDashboard,
  dashboardName,
  onAdd,
}: {
  isSharedDashboard: boolean
  dashboardName?: string
  onAdd: (params: AddWidgetParams) => Promise<void>
}) {
  const [view, setView] = useState<CalendarWidgetView>('month')

  return (
    <div className="p-3 max-h-72 overflow-y-auto space-y-1">
      <div className="px-1 pb-2">
        <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500 mb-2">View</p>
        <ViewTabButtons compact={false} value={view} onChange={setView} />
      </div>

      <button
        type="button"
        onClick={() =>
          void onAdd({
            widget_type: 'calendar',
            config: {
              view,
            },
          })
        }
        className="w-full flex flex-col items-start px-4 py-3 rounded-lg hover:bg-zinc-800 transition-colors text-left"
      >
        <span className="text-sm font-medium text-zinc-200">Calendar</span>
        <span className="text-xs text-zinc-500 mt-0.5">
          {isSharedDashboard
            ? `Everyone on ${dashboardName ?? 'this dashboard'} will see the same events here.`
            : 'Show day, week, or month from this dashboard.'}
        </span>
      </button>
    </div>
  )
}
