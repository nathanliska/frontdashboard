import { apiFetch } from './client'
import type { ResourceAccessSummary, ResourceShare, ShareCreate, ShareUpdate } from './shares'

const listDetailRequests = new Map<string, Promise<ListDetail>>()
const listSummaryRequests = new Map<string, Promise<ListSummary[]>>()

export type ListType = 'checklist' | 'grocery' | 'todo'
export type ItemPriority = 'low' | 'medium' | 'high'

export interface ListSummary {
  id: string
  dashboard_id: string
  name: string
  list_type: ListType
  archived: boolean
  created_by: string
  created_at: string
  updated_at: string
  item_count: number
}

export interface ListItem {
  id: string
  list_id: string
  text: string
  checked: boolean
  sort_order: number
  due_date: string | null
  priority: ItemPriority | null
  category: string | null
  assigned_to: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface ListDetail extends ListSummary {
  items: ListItem[]
}

export async function apiGetLists(dashboardId?: string | null): Promise<ListSummary[]> {
  const query = new URLSearchParams()
  if (dashboardId) query.set('dashboard_id', dashboardId)
  const key = query.toString()
  const existing = listSummaryRequests.get(key)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/lists${query.size ? `?${query.toString()}` : ''}`)
    if (!res.ok) throw new Error('Failed to load lists')
    return res.json() as Promise<ListSummary[]>
  })().finally(() => {
    listSummaryRequests.delete(key)
  })

  listSummaryRequests.set(key, request)
  return request
}

export async function apiGetList(id: string): Promise<ListDetail> {
  const existing = listDetailRequests.get(id)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/lists/${id}`)
    if (!res.ok) throw new Error('List not found')
    return res.json() as Promise<ListDetail>
  })().finally(() => {
    listDetailRequests.delete(id)
  })

  listDetailRequests.set(id, request)
  return request
}

export async function apiCreateList(body: {
  name: string
  list_type: ListType
  dashboard_id: string
}): Promise<ListSummary> {
  const res = await apiFetch('/api/lists', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Failed to create list')
  }
  return res.json() as Promise<ListSummary>
}

export async function apiUpdateList(
  id: string,
  body: { name?: string; archived?: boolean },
): Promise<ListSummary> {
  const res = await apiFetch(`/api/lists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update list')
  return res.json() as Promise<ListSummary>
}

export async function apiDeleteList(id: string): Promise<void> {
  await apiFetch(`/api/lists/${id}`, { method: 'DELETE' })
}

export async function apiCreateItem(listId: string, text: string): Promise<ListItem> {
  const res = await apiFetch(`/api/lists/${listId}/items`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error('Failed to add item')
  return res.json() as Promise<ListItem>
}

export async function apiUpdateItem(
  listId: string,
  itemId: string,
  body: { text?: string; checked?: boolean },
): Promise<ListItem> {
  const res = await apiFetch(`/api/lists/${listId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to update item')
  return res.json() as Promise<ListItem>
}

export async function apiDeleteItem(listId: string, itemId: string): Promise<void> {
  await apiFetch(`/api/lists/${listId}/items/${itemId}`, { method: 'DELETE' })
}

export async function apiGetListShares(listId: string): Promise<ResourceAccessSummary> {
  const res = await apiFetch(`/api/lists/${listId}/shares`)
  if (!res.ok) throw new Error('Failed to load list shares')
  return res.json() as Promise<ResourceAccessSummary>
}

export async function apiAddListShare(listId: string, body: ShareCreate): Promise<ResourceShare> {
  const res = await apiFetch(`/api/lists/${listId}/shares`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Failed to add list share')
  return res.json() as Promise<ResourceShare>
}

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
  return res.json() as Promise<ResourceShare>
}

export async function apiRemoveListShare(listId: string, shareId: string): Promise<void> {
  const res = await apiFetch(`/api/lists/${listId}/shares/${shareId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove list share')
}
