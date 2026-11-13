import type { DashboardWidget } from '../../api/dashboards'

/** The list a widget shows, or null. */
export function boundListId(widget: DashboardWidget): string | null {
  return widget.list_id ?? null
}
