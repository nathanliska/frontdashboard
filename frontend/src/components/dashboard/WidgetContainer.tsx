import { ExternalLink, X } from 'lucide-react'
import { Link } from 'react-router'
import type { DashboardWidget, WidgetType } from '../../api/dashboards'
import { capitalize, cn } from '../../utils/shared/cn'
import { WidgetRenderer } from './WidgetRenderer'

// The two types whose label comes from config are handled below; the rest are static. Keyed by
// the generated widget union, so a new widget type is a type error here until it gets a label.
const WIDGET_LABELS: Record<Exclude<WidgetType, 'list' | 'calendar'>, string> = {
  agenda: 'Agenda',
  clock: 'Clock',
}

function widgetLabel(widget: DashboardWidget): string {
  // List widgets store the bound list's name in config.list_name at creation time.
  if (widget.widget_type === 'list') {
    const label = widget.config.list_name || 'List'
    const type = widget.config.list_type
    return type ? `${label} · ${capitalize(type)}` : label
  }
  if (widget.widget_type === 'calendar') {
    return `Calendar · ${capitalize(widget.config.view || 'month')}`
  }
  return WIDGET_LABELS[widget.widget_type]
}

export function WidgetContainer({
  widget,
  dashboardId,
  isSharedDashboard,
  canEdit,
  onRemove,
  children,
}: {
  widget: DashboardWidget
  dashboardId: string
  isSharedDashboard: boolean
  canEdit: boolean
  onRemove?: () => void
  children?: React.ReactNode
}) {
  const listUrl =
    widget.widget_type === 'list' && widget.resource_id
      ? `/lists/${widget.resource_id}?dashboard_id=${dashboardId}`
      : null

  return (
    <div className="relative flex flex-col h-full bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden group">
      {/* Header / drag handle */}
      <div
        className={cn(
          'drag-handle flex items-center justify-between gap-2 px-2.5 sm:px-3 py-2 border-b border-zinc-800 shrink-0 select-none',
          canEdit && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <span className="min-w-0 text-[11px] sm:text-xs text-zinc-500 truncate">
          {widgetLabel(widget)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {(widget.widget_type === 'list' && widget.resource_id) ||
          widget.widget_type === 'calendar' ||
          widget.widget_type === 'agenda' ? (
            <Link
              to={
                widget.widget_type === 'calendar' || widget.widget_type === 'agenda'
                  ? `/calendar?dashboard_id=${dashboardId}`
                  : (listUrl ?? '/lists')
              }
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="text-zinc-600 hover:text-zinc-400 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
              aria-label={
                widget.widget_type === 'calendar' || widget.widget_type === 'agenda'
                  ? 'Open calendar'
                  : 'Open full list'
              }
            >
              <ExternalLink size={11} />
            </Link>
          ) : null}
          {canEdit && onRemove && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onRemove()
              }}
              className="text-zinc-600 hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
              aria-label="Remove widget"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 min-h-0 p-2.5 sm:p-3">
        {children ?? (
          <WidgetRenderer
            widget={widget}
            dashboardId={dashboardId}
            isSharedDashboard={isSharedDashboard}
          />
        )}
      </div>
    </div>
  )
}
