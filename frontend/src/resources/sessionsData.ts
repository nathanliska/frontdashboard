import { useMemo } from 'react'
import { apiListSessions, apiRevokeSession } from '../api/auth'
import type { SessionCursor, SessionPage } from '../api/generated/contract'
import { currentSessionGeneration } from '../stores/sessionGeneration'
import { registerResourceReset } from './resetRegistry'
import { createScopedQuery } from './scopedQuery'

type Scope = { cursor: SessionCursor | null }
const revoked = new Set<string>()
const sessionsQuery = createScopedQuery<Scope, SessionPage>({
  getKey: ({ cursor }) => (cursor ? `${cursor.created_at}:${cursor.id}` : 'newest'),
  fetcher: async ({ cursor }) => {
    const page = await apiListSessions(cursor)
    // A refresh started before a revocation must not put its row back when it arrives later.
    return { ...page, items: page.items.filter((session) => !revoked.has(session.id)) }
  },
  fallbackErrorMessage: 'Failed to load sessions.',
})

/** Session pages are shared across StrictMode mounts and cleared at every auth boundary. */
export function useSessions(cursor: SessionCursor | null) {
  const scope = useMemo(() => ({ cursor }), [cursor])
  return sessionsQuery.useQuery(scope)
}

/** Remove a successfully revoked session from every loaded page without a follow-up GET. */
export async function revokeOtherSession(id: string): Promise<void> {
  const generation = currentSessionGeneration()
  await apiRevokeSession(id)
  if (generation !== currentSessionGeneration()) return
  revoked.add(id)
  sessionsQuery.updateWhere(
    () => true,
    (state) =>
      state.data
        ? {
            ...state,
            data: { ...state.data, items: state.data.items.filter((session) => session.id !== id) },
          }
        : state,
  )
}

function resetSessionsData(): void {
  sessionsQuery.reset()
  revoked.clear()
}

registerResourceReset(resetSessionsData)
