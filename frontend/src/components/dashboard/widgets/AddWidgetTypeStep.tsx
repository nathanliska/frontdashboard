import { DEFAULT_TIMEZONE } from '../../../utils/calendar/calendarUtils'
import type { AddWidgetParams } from '../../../utils/dashboard/widgetCreationTypes'

const WIDGET_TYPES = [
  {
    type: 'calendar',
    label: 'Calendar',
    description: 'Day, week, or month view',
  },
  {
    type: 'list',
    label: 'List',
    description: 'Checklist, grocery list, or to-do list',
  },
  {
    type: 'clock',
    label: 'Clock',
    description: 'Current time and date',
  },
] as const

export function AddWidgetTypeStep({
  isSharedDashboard,
  dashboardName,
  onPickList,
  onPickCalendar,
  onAdd,
}: {
  isSharedDashboard: boolean
  dashboardName?: string
  onPickList: () => void
  onPickCalendar: () => void
  onAdd: (params: AddWidgetParams) => Promise<void>
}) {
  return (
    <div className="p-3 space-y-1">
      {isSharedDashboard && (
        <div className="px-4 py-3 rounded-lg border border-zinc-800 bg-zinc-950/60">
          <p className="text-sm text-zinc-200">Shared dashboard</p>
          <p className="text-xs text-zinc-500 mt-1">
            Everyone with access to {dashboardName ?? 'this dashboard'} should see the same widget
            content here.
          </p>
        </div>
      )}
      {WIDGET_TYPES.map(({ type, label, description }) => {
        const effectiveDescription =
          type === 'calendar'
            ? isSharedDashboard
              ? 'Show events visible to everyone with access to this dashboard'
              : 'Your own accessible events'
            : type === 'clock' && isSharedDashboard
              ? 'Uses one shared timezone for everyone'
              : description
        return (
          <button
            type="button"
            key={type}
            onClick={() => {
              if (type === 'list') {
                onPickList()
              } else if (type === 'calendar') {
                onPickCalendar()
              } else if (type === 'clock') {
                void onAdd({
                  widget_type: type,
                  config: isSharedDashboard ? { timezone: DEFAULT_TIMEZONE } : {},
                })
              } else {
                void onAdd({ widget_type: type })
              }
            }}
            className="w-full flex flex-col items-start px-4 py-3 rounded-lg text-left transition-colors hover:bg-zinc-800"
          >
            <span className="text-sm font-medium text-zinc-200">{label}</span>
            <span className="text-xs text-zinc-500 mt-0.5">{effectiveDescription}</span>
          </button>
        )
      })}
    </div>
  )
}
