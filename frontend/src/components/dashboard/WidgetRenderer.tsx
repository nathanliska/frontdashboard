import type { DashboardWidget } from '../../api/dashboards'
import { CalendarWidget } from './widgets/CalendarWidget'
import { ClockWidget } from './widgets/ClockWidget'
import { ListWidget } from './widgets/ListWidget'

export function WidgetRenderer({
  widget,
  dashboardId,
  isSharedDashboard,
}: {
  widget: DashboardWidget
  dashboardId: string
  isSharedDashboard: boolean
}) {
  switch (widget.widget_type) {
    case 'list':
      if (!widget.resource_id) return <BrokenWidget message="No list bound." />
      return <ListWidget listId={widget.resource_id} widgetId={widget.id} config={widget.config} />

    case 'clock':
      return <ClockWidget config={widget.config} isSharedDashboard={isSharedDashboard} />

    case 'calendar':
      return (
        <CalendarWidget widgetId={widget.id} dashboardId={dashboardId} config={widget.config} />
      )

    default:
      return (
        <div className="h-full flex items-center justify-center">
          <p className="text-xs text-zinc-600">{widget.widget_type}</p>
        </div>
      )
  }
}

function BrokenWidget({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1">
      <p className="text-xs text-zinc-600">{message}</p>
    </div>
  )
}
