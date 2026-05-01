export type WidgetType = 'calendar' | 'agenda' | 'list' | 'clock'

export interface AddWidgetParams {
  widget_type: WidgetType
  config?: Record<string, unknown>
  resource_type?: string | null
  resource_id?: string | null
}
