import { z } from 'zod'
import { apiFetch } from './client'
import { UserSearchResult } from './generated/contract'
import { parseJson } from './http'

export type { UserSearchResult as SearchUserResult } from './generated/contract'

export async function apiSearchUsers(q: string): Promise<UserSearchResult[]> {
  const query = new URLSearchParams({ q })
  const res = await apiFetch(`/api/users/search?${query.toString()}`)
  if (!res.ok) throw new Error('Failed to search users')
  return parseJson(res, z.array(UserSearchResult))
}
