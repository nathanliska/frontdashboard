import type { CalendarEvent, CalendarOccurrence, CreateCalendarEventInput } from './calendar'
import { apiFetch } from './client'
import type { ResourceShare, ShareCreate, ShareUpdate } from './shares'

const dashboardRequests = new Map<string, Promise<Dashboard>>()
const dashboardShareRequests = new Map<string, Promise<ResourceShare[]>>()

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
  archived: boolean
  access_description: string | null
  is_shared: boolean
  can_edit: boolean
  can_manage_shares: boolean
  is_favorite: boolean
  version: number
  created_at: string
  updated_at: string
}

export interface Dashboard {
  id: string
  user_id: string
  name: string
  archived: boolean
  is_shared: boolean
  can_edit: boolean
  can_manage_shares: boolean
  is_favorite: boolean
  layout: LayoutItem[]
  version: number
  widgets: DashboardWidget[]
}

export type UpdateLayoutResult =
  | { conflict: false; dashboard: Dashboard }
  | { conflict: true; detail?: string }

export interface DashboardMutationOptions {
  clientMutationId?: string
}

function buildDashboardMutationHeaders(
  options?: DashboardMutationOptions,
): Record<string, string> | undefined {
  if (!options?.clientMutationId) return undefined
  return { 'X-Client-Mutation-Id': options.clientMutationId }
}

export async function apiListDashboards(): Promise<DashboardSummary[]> {
  const res = await apiFetch('/api/dashboards')
  if (!res.ok) throw new Error('Failed to load dashboards')
  return res.json() as Promise<DashboardSummary[]>
}

export async function apiGetDashboard(id: string): Promise<Dashboard> {
  const existing = dashboardRequests.get(id)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/dashboards/${id}`)
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { detail?: string }
      const error = new Error(data.detail ?? 'Failed to load dashboard') as Error & {
        status?: number
      }
      error.status = res.status
      throw error
    }
    return res.json() as Promise<Dashboard>
  })().finally(() => {
    dashboardRequests.delete(id)
  })

  dashboardRequests.set(id, request)
  return request
}

export async function apiCreateDashboard(
  data: {
    name: string
    shares?: ShareCreate[]
  },
  options?: DashboardMutationOptions,
): Promise<DashboardSummary> {
  const res = await apiFetch('/api/dashboards', {
    method: 'POST',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create dashboard')
  return res.json() as Promise<DashboardSummary>
}

export async function apiUpdateDashboardMeta(
  id: string,
  data: { name?: string; archived?: boolean },
  options?: DashboardMutationOptions,
): Promise<DashboardSummary> {
  const res = await apiFetch(`/api/dashboards/${id}`, {
    method: 'PATCH',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update dashboard')
  return res.json() as Promise<DashboardSummary>
}

export async function apiDeleteDashboard(
  id: string,
  options?: DashboardMutationOptions,
): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${id}`, {
    method: 'DELETE',
    headers: buildDashboardMutationHeaders(options),
  })
  if (!res.ok) throw new Error('Failed to delete dashboard')
}

export async function apiUpdateLayout(
  dashboardId: string,
  layout: LayoutItem[],
  version: number,
  options?: DashboardMutationOptions,
): Promise<UpdateLayoutResult> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/layout`, {
    method: 'PUT',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify({ layout, version }),
  })
  if (res.status === 409) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    return { conflict: true, detail: data.detail }
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to save layout')
  }
  return { conflict: false, dashboard: (await res.json()) as Dashboard }
}

export async function apiAddWidget(
  dashboardId: string,
  widget: {
    widget_type: string
    config?: Record<string, unknown>
    resource_type?: string | null
    resource_id?: string | null
  },
  options?: DashboardMutationOptions,
): Promise<Dashboard> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets`, {
    method: 'POST',
    headers: buildDashboardMutationHeaders(options),
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
  options?: DashboardMutationOptions,
): Promise<DashboardWidget> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
    method: 'PATCH',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify({ config }),
  })
  if (!res.ok) throw new Error('Failed to update widget')
  return res.json() as Promise<DashboardWidget>
}

export async function apiRemoveWidget(
  dashboardId: string,
  widgetId: string,
  options?: DashboardMutationOptions,
): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
    method: 'DELETE',
    headers: buildDashboardMutationHeaders(options),
  })
  if (!res.ok) throw new Error('Failed to remove widget')
}

export async function apiGetDashboardShares(dashboardId: string): Promise<ResourceShare[]> {
  const existing = dashboardShareRequests.get(dashboardId)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/dashboards/${dashboardId}/shares`)
    if (!res.ok) throw new Error('Failed to load dashboard shares')
    return res.json() as Promise<ResourceShare[]>
  })().finally(() => {
    dashboardShareRequests.delete(dashboardId)
  })

  dashboardShareRequests.set(dashboardId, request)
  return request
}

export async function apiAddDashboardShare(
  dashboardId: string,
  body: ShareCreate,
  options?: DashboardMutationOptions,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares`, {
    method: 'POST',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to add dashboard share')
  return res.json() as Promise<ResourceShare>
}

export async function apiUpdateDashboardShare(
  dashboardId: string,
  shareId: string,
  body: ShareUpdate,
  options?: DashboardMutationOptions,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'PATCH',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update dashboard share')
  return res.json() as Promise<ResourceShare>
}

export async function apiRemoveDashboardShare(
  dashboardId: string,
  shareId: string,
  options?: DashboardMutationOptions,
): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'DELETE',
    headers: buildDashboardMutationHeaders(options),
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
