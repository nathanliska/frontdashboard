import { z } from 'zod'
import { apiFetch } from './client'
import {
  ListDetailResponse,
  ListItemResponse,
  ListResponse,
  type ListType,
  ResourceAccessResponse,
  ShareResponse,
  TrashedListSummary,
} from './generated/contract'
import { parseJson, requestVoid } from './http'
import type { ResourceAccessSummary, ResourceShare, ShareCreate, ShareUpdate } from './shares'

const listDetailRequests = new Map<string, Promise<ListDetailResponse>>()
const listSummaryRequests = new Map<string, Promise<ListResponse[]>>()

export type {
  ItemPriority,
  ListDetailResponse as ListDetail,
  ListItemResponse as ListItem,
  ListResponse as ListSummary,
  ListType,
  TrashedListSummary as TrashedList,
} from './generated/contract'

export interface ListMutationOptions {
  clientMutationId?: string
}

function buildListMutationHeaders(
  options?: ListMutationOptions,
): Record<string, string> | undefined {
  if (!options?.clientMutationId) return undefined
  return { 'X-Client-Mutation-Id': options.clientMutationId }
}

export async function apiGetLists(dashboardId?: string | null): Promise<ListResponse[]> {
  const query = new URLSearchParams()
  if (dashboardId) query.set('dashboard_id', dashboardId)
  const key = query.toString()
  const existing = listSummaryRequests.get(key)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/lists${query.size ? `?${query.toString()}` : ''}`)
    if (!res.ok) throw new Error('Failed to load lists')
    return parseJson(res, z.array(ListResponse))
  })().finally(() => {
    listSummaryRequests.delete(key)
  })

  listSummaryRequests.set(key, request)
  return request
}

export async function apiGetListDetails(dashboardId: string): Promise<ListDetailResponse[]> {
  // The agenda's batch fetch (#17): every list on the dashboard with its items, one request.
  // No single-flight map: its only caller is a scopedQuery fetcher, which already dedupes.
  const res = await apiFetch(`/api/lists/details?dashboard_id=${dashboardId}`)
  if (!res.ok) throw new Error('Failed to load lists')
  return parseJson(res, z.array(ListDetailResponse))
}

export async function apiGetList(id: string): Promise<ListDetailResponse> {
  const existing = listDetailRequests.get(id)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/lists/${id}`)
    if (!res.ok) throw new Error('List not found')
    return parseJson(res, ListDetailResponse)
  })().finally(() => {
    listDetailRequests.delete(id)
  })

  listDetailRequests.set(id, request)
  return request
}

export async function apiCreateList(
  body: {
    name: string
    list_type: ListType
    dashboard_id: string
  },
  options?: ListMutationOptions,
): Promise<ListResponse> {
  const res = await apiFetch('/api/lists', {
    method: 'POST',
    headers: buildListMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to create list')
  }
  return parseJson(res, ListResponse)
}

export async function apiUpdateList(
  id: string,
  body: { name?: string },
  options?: ListMutationOptions,
): Promise<ListResponse> {
  const res = await apiFetch(`/api/lists/${id}`, {
    method: 'PATCH',
    headers: buildListMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update list')
  return parseJson(res, ListResponse)
}

export async function apiDeleteList(id: string, options?: ListMutationOptions): Promise<void> {
  await requestVoid(
    `/api/lists/${id}`,
    { method: 'DELETE', headers: buildListMutationHeaders(options) },
    'Failed to delete list',
  )
}

export async function apiGetListTrash(dashboardId: string): Promise<TrashedListSummary[]> {
  const res = await apiFetch(`/api/lists/trash?dashboard_id=${dashboardId}`)
  if (!res.ok) throw new Error('Failed to load trashed lists')
  return parseJson(res, z.array(TrashedListSummary))
}

export async function apiRestoreList(
  id: string,
  options?: ListMutationOptions,
): Promise<ListResponse> {
  const res = await apiFetch(`/api/lists/${id}/restore`, {
    method: 'POST',
    headers: buildListMutationHeaders(options),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to restore list')
  }
  return parseJson(res, ListResponse)
}

export async function apiCreateItem(
  listId: string,
  text: string,
  options?: ListMutationOptions,
): Promise<ListItemResponse> {
  const res = await apiFetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    headers: buildListMutationHeaders(options),
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error('Failed to add item')
  return parseJson(res, ListItemResponse)
}

export async function apiUpdateItem(
  listId: string,
  itemId: string,
  body: { text?: string; checked?: boolean },
  options?: ListMutationOptions,
): Promise<ListItemResponse> {
  const res = await apiFetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'PATCH',
    headers: buildListMutationHeaders(options),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update item')
  return parseJson(res, ListItemResponse)
}

export async function apiDeleteItem(
  listId: string,
  itemId: string,
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/${listId}/items/${itemId}`,
    { method: 'DELETE', headers: buildListMutationHeaders(options) },
    'Failed to delete item',
  )
}

export async function apiReorderItems(
  listId: string,
  itemIds: string[],
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/${listId}/items/order`,
    {
      method: 'PUT',
      headers: buildListMutationHeaders(options),
      body: JSON.stringify({ item_ids: itemIds }),
    },
    'Failed to reorder items',
  )
}

export async function apiReorderLists(
  dashboardId: string,
  listIds: string[],
  options?: ListMutationOptions,
): Promise<void> {
  await requestVoid(
    `/api/lists/order`,
    {
      method: 'PUT',
      headers: buildListMutationHeaders(options),
      body: JSON.stringify({ dashboard_id: dashboardId, list_ids: listIds }),
    },
    'Failed to reorder lists',
  )
}

/**
 * @knipignore Child-resource sharing is dashboard-inherited: the backend
 * `/lists/{id}/shares` endpoints are deliberate 409 stubs, so these wrappers are
 * intentionally unused scaffolding rather than dead code. See CLAUDE.md "Sharing model".
 */
export async function apiGetListShares(listId: string): Promise<ResourceAccessSummary> {
  const res = await apiFetch(`/api/lists/${listId}/shares`)
  if (!res.ok) throw new Error('Failed to load list shares')
  return parseJson(res, ResourceAccessResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetListShares above. */
export async function apiAddListShare(listId: string, body: ShareCreate): Promise<ResourceShare> {
  const res = await apiFetch(`/api/lists/${listId}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to add list share')
  return parseJson(res, ShareResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetListShares above. */
export async function apiUpdateListShare(
  listId: string,
  shareId: string,
  body: ShareUpdate,
): Promise<ResourceShare> {
  const res = await apiFetch(`/api/lists/${listId}/shares/${shareId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update list share')
  return parseJson(res, ShareResponse)
}

/** @knipignore Unused scaffolding — see the note on apiGetListShares above. */
export async function apiRemoveListShare(listId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/lists/${listId}/shares/${shareId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove list share')
}
