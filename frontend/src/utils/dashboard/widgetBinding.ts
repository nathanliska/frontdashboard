import type { DashboardWidget } from '../../api/dashboards'

/**
 * The list a widget shows, or null. Falls back to the generic `resource_*` pair, which is all a
 * backend one release behind sends. That covers reads only: such a backend rejects `list_id` on add.
 */
export function boundListId(widget: DashboardWidget): string | null {
  if (widget.list_id) return widget.list_id
  return widget.resource_type === 'list' ? (widget.resource_id ?? null) : null
}
