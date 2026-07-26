import { z } from 'zod'
import { apiFetch } from './client'
import {
  AgendaWidgetResponse,
  CalendarWidgetResponse,
  ClockWidgetResponse,
  DashboardResponse,
  DashboardSummary,
  ListWidgetResponse,
  ShareResponse,
} from './generated/contract'
import { parseJson } from './http'
import type { ResourceShare, ShareCreate, ShareUpdate } from './shares'

// Share reads are the one place a single-flight earns its keep: the settings modal fetches them
// from an effect with no coalescing layer above it, and StrictMode double-invokes that effect in
// development. Dashboard reads are coalesced by the store instead — see apiGetDashboard.
const dashboardShareRequests = new Map<string, Promise<ResourceShare[]>>()

export type { DashboardSummary } from './generated/contract'

// The backend types `layout` as `list[dict[str, Any]]`, so the generated schema can only say
// "array of objects". Layout entries are only ever written by react-grid-layout, whose item
// shape we do know — so the boundary validates against that shape here rather than casting.
// (#14's "typed layout models" would move this server-side and make it generated too.)
export const LayoutItemSchema = z
  .object({
    i: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  // react-grid-layout round-trips extra per-item keys (static, minW, moved…) — keep them.
  .passthrough()

export type LayoutItem = z.infer<typeof LayoutItemSchema>

// No standalone `WidgetResponse` in the generated contract — FastAPI inlines the discriminated
// union, so it is composed here from the generated variants. `widget_type` generates as a
// literal per variant (see backend/app/openapi_export.py), so this narrows through `switch`.
export const DashboardWidgetSchema = z.discriminatedUnion('widget_type', [
  ClockWidgetResponse,
  CalendarWidgetResponse,
  ListWidgetResponse,
  AgendaWidgetResponse,
])

export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>
export type WidgetType = DashboardWidget['widget_type']

export type {
  AgendaWidgetConfig,
  CalendarWidgetConfig,
  ClockWidgetConfig,
  ListWidgetConfig,
} from './generated/contract'

const DashboardSchema = DashboardResponse.extend({
  layout: z.array(LayoutItemSchema),
  widgets: z.array(DashboardWidgetSchema),
})

export type Dashboard = z.infer<typeof DashboardSchema>

export type UpdateLayoutResult =
  | { conflict: false; dashboard: Dashboard }
  | { conflict: true; detail?: string }

export interface DashboardMutationOptions {
  clientMutationId?: string
}

async function parseDashboard(res: Response): Promise<Dashboard> {
  return parseJson(res, DashboardSchema)
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
  return parseJson(res, z.array(DashboardSummary))
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
  return parseJson(res, DashboardSummary)
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
  return parseJson(res, DashboardSummary)
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
  return { conflict: false, dashboard: await parseDashboard(res) }
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
  return parseDashboard(res)
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
  return parseJson(res, DashboardWidgetSchema)
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
  options?: DashboardMutationOptions,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/shares/${shareId}`, {
    method: 'PATCH',
    headers: buildDashboardMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update dashboard share')
  return parseJson(res, ShareResponse)
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
