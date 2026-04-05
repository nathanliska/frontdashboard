import { apiFetch } from './client'
import type { CalendarEvent, CalendarOccurrence, CreateCalendarEventInput } from './calendar'
import type { ResourceShare, ShareCreate, ShareUpdate } from './shares'

export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  [key: string]: unknown
}

export interface DashboardWidget {
  id: string
  dashboard_id: string
  widget_type: string
  widget_version: number
  config: Record<string, unknown>
  resource_type: string | null
  resource_id: string | null
  created_at: string
  updated_at: string
}

export interface DashboardSummary {
  id: string
  user_id: string
  name: string
  access_description: string | null
  is_shared: boolean
  is_favorite: boolean
  version: number
  created_at: string
  updated_at: string
}

export interface Dashboard {
  id: string
  user_id: string
  name: string
  is_shared: boolean
  is_favorite: boolean
  layout: LayoutItem[]
  version: number
  widgets: DashboardWidget[]
}

export async function apiListDashboards(): Promise<DashboardSummary[]> {
  const res = await apiFetch('/api/dashboards')
  if (!res.ok) throw new Error('Failed to load dashboards')
  return res.json() as Promise<DashboardSummary[]>
}

export async function apiGetDashboard(id: string): Promise<Dashboard> {
  const res = await apiFetch(`/api/dashboards/${id}`)
  if (!res.ok) throw new Error('Failed to load dashboard')
  return res.json() as Promise<Dashboard>
}

export async function apiCreateDashboard(data: {
  name: string
  shares?: ShareCreate[]
}): Promise<DashboardSummary> {
  const res = await apiFetch('/api/dashboards', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create dashboard')
  return res.json() as Promise<DashboardSummary>
}

export async function apiUpdateDashboardMeta(
  id: string,
  data: { name?: string; is_favorite?: boolean },
): Promise<DashboardSummary> {
  const res = await apiFetch(`/api/dashboards/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update dashboard')
  return res.json() as Promise<DashboardSummary>
}

export async function apiDeleteDashboard(id: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete dashboard')
}

export async function apiUpdateLayout(
  dashboardId: string,
  layout: LayoutItem[],
  version: number,
): Promise<{ data: Dashboard; status: number }> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/layout`, {
    method: 'PUT',
    body: JSON.stringify({ layout, version }),
  })
  return { data: (await res.json()) as Dashboard, status: res.status }
}

export async function apiAddWidget(
  dashboardId: string,
  widget: {
    widget_type: string
    config?: Record<string, unknown>
    resource_type?: string | null
    resource_id?: string | null
  },
): Promise<Dashboard> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets`, {
    method: 'POST',
    body: JSON.stringify(widget),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to add widget')
  }
  return res.json() as Promise<Dashboard>
}

export async function apiUpdateWidget(
  dashboardId: string,
  widgetId: string,
  config: Record<string, unknown>,
): Promise<DashboardWidget> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ config }),
  })
  if (!res.ok) throw new Error('Failed to update widget')
  return res.json() as Promise<DashboardWidget>
}

export async function apiRemoveWidget(dashboardId: string, widgetId: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to remove widget')
}

export async function apiGetDashboardShares(dashboardId: string): Promise<ResourceShare[]> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares`)
  if (!res.ok) throw new Error('Failed to load dashboard shares')
  return res.json() as Promise<ResourceShare[]>
}

export async function apiAddDashboardShare(
  dashboardId: string,
  body: ShareCreate,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to add dashboard share')
  return res.json() as Promise<ResourceShare>
}

export async function apiUpdateDashboardShare(
  dashboardId: string,
  shareId: string,
  body: ShareUpdate,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update dashboard share')
  return res.json() as Promise<ResourceShare>
}

export async function apiRemoveDashboardShare(dashboardId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to remove dashboard share')
}

export async function apiGetDashboardCalendarOccurrences(params: {
  dashboardId: string
  windowStart: string
  windowEnd: string
}): Promise<CalendarOccurrence[]> {
  const query = new URLSearchParams({
    window_start: params.windowStart,
    window_end: params.windowEnd,
  })
  const res = await apiFetch(
    `/api/dashboards/${params.dashboardId}/calendar-occurrences?${query.toString()}`,
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to load dashboard calendar')
  }
  return res.json() as Promise<CalendarOccurrence[]>
}

export async function apiCreateDashboardCalendarEvent(
  dashboardId: string,
  input: CreateCalendarEventInput,
): Promise<CalendarEvent> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/calendar-events`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to create dashboard event')
  }
  return res.json() as Promise<CalendarEvent>
}
