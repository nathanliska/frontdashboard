// The set of creatable types is the set of renderable ones — derived from the generated widget
// response union so the two can't drift (the backend's WidgetCreate.widget_type is a bare str).
import type { WidgetType } from '../../api/dashboards'

export interface AddWidgetParams {
  widget_type: WidgetType
  config?: Record<string, unknown>
  resource_type?: string | null
  resource_id?: string | null
}
