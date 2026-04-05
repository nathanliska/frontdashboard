import { apiFetch } from './client'

export interface SearchUserResult {
  id: string
  display_name: string
  email: string
}

export async function apiSearchUsers(q: string): Promise<SearchUserResult[]> {
  const query = new URLSearchParams({ q })
  const res = await apiFetch(`/api/users/search?${query.toString()}`)
  if (!res.ok) throw new Error('Failed to search users')
  return res.json() as Promise<SearchUserResult[]>
}
