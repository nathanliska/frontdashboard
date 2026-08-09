import { z } from 'zod'
import { apiFetch } from './client'
import {
  type AgendaWidgetCreate,
  AgendaWidgetResponse,
  type CalendarWidgetCreate,
  CalendarWidgetResponse,
  type ClockWidgetCreate,
  ClockWidgetResponse,
  DashboardMemberResponse,
  DashboardResponse,
  DashboardSummary,
  type LayoutItem,
  type ListWidgetCreate,
  ListWidgetResponse,
  ShareResponse,
  TrashedDashboardSummary,
} from './generated/contract'
import { parseJson } from './http'
import type { ResourceShare, ShareCreate, ShareUpdate } from './shares'

// Share reads are the one place a single-flight earns its keep: the settings modal fetches them
// from an effect with no coalescing layer above it, and StrictMode double-invokes that effect in
// development. Dashboard reads are coalesced by the store instead — see apiGetDashboard.
const dashboardShareRequests = new Map<string, Promise<ResourceShare[]>>()

export type {
  DashboardSummary,
  LayoutItem,
  TrashedDashboardSummary as TrashedDashboard,
} from './generated/contract'

import type { DashboardSummary as DashboardSummaryType } from './generated/contract'

// Layout items are generated now: the backend types `layout` as `list[LayoutItem]` and owns
// the write-side bounds. `{i, x, y, w, h}` IS the layout state — react-grid-layout's transient
// per-item bookkeeping (static, minW, moved…) is dropped by the backend on save and re-derived by
// the library every render, so nothing here needs to preserve it.

// A create is the response union's mirror: `widget_type` discriminates, each variant carries its
// own typed config, and only the list variant can bind a resource.
export type WidgetCreate =
  | ClockWidgetCreate
  | CalendarWidgetCreate
  | ListWidgetCreate
  | AgendaWidgetCreate

// No standalone `WidgetResponse` in the generated contract — FastAPI inlines the discriminated
// union, so it is composed here from the generated variants. `widget_type` generates as a
// literal per variant (see backend/app/openapi_export.py), so this narrows through `switch`.
const DashboardWidgetSchema = z.discriminatedUnion('widget_type', [
  ClockWidgetResponse,
  CalendarWidgetResponse,
  ListWidgetResponse,
  AgendaWidgetResponse,
])

export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>
export type WidgetType = DashboardWidget['widget_type']

export type {
  CalendarWidgetConfig,
  ClockWidgetConfig,
  ListWidgetConfig,
} from './generated/contract'

const DashboardSchema = DashboardResponse.extend({
  widgets: z.array(DashboardWidgetSchema),
})

export type Dashboard = z.infer<typeof DashboardSchema>

export type UpdateLayoutResult =
  | { conflict: false; dashboard: Dashboard }
  | { conflict: true; detail?: string }

async function parseDashboard(res: Response): Promise<Dashboard> {
  return parseJson(res, DashboardSchema)
}

export async function apiListDashboards(): Promise<DashboardSummary[]> {
  const res = await apiFetch('/api/dashboards')
  if (!res.ok) throw new Error('Failed to load dashboards')
  return parseJson(res, z.array(DashboardSummary))
}

// Not single-flighted: fetched once per editor open, from a non-StrictMode-doubled handler.
export async function apiListDashboardMembers(
  dashboardId: string,
): Promise<DashboardMemberResponse[]> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/members`)
  if (!res.ok) throw new Error('Failed to load members')
  return parseJson(res, z.array(DashboardMemberResponse))
}

// Not single-flighted: the only caller is the dashboard store's loadDashboard, which coalesces by
// id above this layer *and* merges load options across a queued follow-up. A second dedupe here
// would only ever swallow the request that store logic deliberately re-issues.
export async function apiGetDashboard(id: string): Promise<Dashboard> {
  const res = await apiFetch(`/api/dashboards/${id}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    const error = new Error(data.detail ?? 'Failed to load dashboard') as Error & {
      status?: number
    }
    error.status = res.status
    throw error
  }
  return parseDashboard(res)
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
  return parseJson(res, DashboardSummary)
}

export async function apiUpdateDashboardMeta(
  id: string,
  data: { name?: string },
): Promise<DashboardSummary> {
  const res = await apiFetch(`/api/dashboards/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update dashboard')
  return parseJson(res, DashboardSummary)
}

export async function apiDeleteDashboard(id: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${id}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to delete dashboard')
}

export async function apiGetTrash(): Promise<TrashedDashboardSummary[]> {
  const res = await apiFetch('/api/dashboards/trash')
  if (!res.ok) throw new Error('Failed to load trash')
  return parseJson(res, z.array(TrashedDashboardSummary))
}

export async function apiRestoreDashboard(id: string): Promise<DashboardSummaryType> {
  const res = await apiFetch(`/api/dashboards/${id}/restore`, {
    method: 'POST',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to restore dashboard')
  }
  return parseJson(res, DashboardSummary)
}

export async function apiUpdateLayout(
  dashboardId: string,
  layout: LayoutItem[],
  version: number,
): Promise<UpdateLayoutResult> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/layout`, {
    method: 'PUT',
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
  return { conflict: false, dashboard: await parseDashboard(res) }
}

export async function apiAddWidget(dashboardId: string, widget: WidgetCreate): Promise<Dashboard> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets`, {
    method: 'POST',
    body: JSON.stringify(widget),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to add widget')
  }
  return parseDashboard(res)
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
  return parseJson(res, DashboardWidgetSchema)
}

export async function apiRemoveWidget(dashboardId: string, widgetId: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to remove widget')
}

export async function apiGetDashboardShares(dashboardId: string): Promise<ResourceShare[]> {
  const existing = dashboardShareRequests.get(dashboardId)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/dashboards/${dashboardId}/shares`)
    if (!res.ok) throw new Error('Failed to load dashboard shares')
    return parseJson(res, z.array(ShareResponse))
  })().finally(() => {
    dashboardShareRequests.delete(dashboardId)
  })

  dashboardShareRequests.set(dashboardId, request)
  return request
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
  return parseJson(res, ShareResponse)
}

export async function apiRemoveDashboardShare(dashboardId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('Failed to remove dashboard share')
}
