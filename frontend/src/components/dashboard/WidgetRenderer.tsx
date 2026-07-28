import type { DashboardWidget } from '../../api/dashboards'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { AgendaWidget } from './widgets/AgendaWidget'
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
  // Keyed by widget id so a crashed tile resets when the grid hands this slot a different widget,
  // rather than showing the previous one's error.
  return (
    <ErrorBoundary
      key={widget.id}
      label={`${widget.widget_type} widget`}
      fallback={(reset) => <CrashedWidget onRetry={reset} />}
    >
      <WidgetBody widget={widget} dashboardId={dashboardId} isSharedDashboard={isSharedDashboard} />
    </ErrorBoundary>
  )
}

function WidgetBody({
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

    case 'agenda':
      return <AgendaWidget dashboardId={dashboardId} />

    default:
      // The widget union is generated from the backend contract, so a new widget type lands
      // here as a type error until it gets a case above (see frontend/CLAUDE.md).
      return <UnknownWidget widget={widget} />
  }
}

function UnknownWidget({ widget }: { widget: never }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-xs text-zinc-600">{(widget as DashboardWidget).widget_type}</p>
    </div>
  )
}

function BrokenWidget({ message }: { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1">
      <p className="text-xs text-zinc-600">{message}</p>
    </div>
  )
}

function CrashedWidget({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1">
      <p className="text-xs text-zinc-600">This widget failed to load.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
      >
        Try again
      </button>
    </div>
  )
}
