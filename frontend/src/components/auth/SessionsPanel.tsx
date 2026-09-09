import { useState } from 'react'
import type { SessionCursor } from '../../api/generated/contract'
import { revokeOtherSession, useSessions } from '../../resources/sessionsData'
import { currentSessionGeneration } from '../../stores/sessionGeneration'
import { LoadingBlock } from '../ui/Spinner'

/** A snapshot of live sign-ins with explicit refresh and immediate local removal after revocation. */
export function SessionsPanel() {
  const [cursor, setCursor] = useState<SessionCursor | null>(null)
  const { data, loading, error, refetch } = useSessions(cursor)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  async function revoke(id: string) {
    const generation = currentSessionGeneration()
    setRevoking(id)
    setRevokeError(null)
    try {
      await revokeOtherSession(id)
    } catch (error) {
      if (generation === currentSessionGeneration()) {
        setRevokeError(error instanceof Error ? error.message : 'Failed to revoke session.')
      }
    } finally {
      if (generation === currentSessionGeneration()) setRevoking(null)
    }
  }

  const disabled = loading || revoking !== null
  return (
    <div className="space-y-4 border-t border-zinc-800 px-5 py-4">
      <p className="text-sm text-zinc-400">
        Sign-ins that can still access your account. Activity times are approximate. Refresh to
        check for changes on other devices.
      </p>
      {(error || revokeError) && (
        <p role="alert" className="text-sm text-red-300">
          {revokeError ?? error?.message}
        </p>
      )}
      {!data && loading && <LoadingBlock label="Loading sessions" />}
      {data && (
        <ul className="space-y-3">
          {data.items.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 p-3"
            >
              <div className="space-y-1 text-sm">
                <p className="text-zinc-200">
                  {session.is_current ? 'This session' : 'Other session'}
                </p>
                <p className="text-zinc-400">
                  Signed in{' '}
                  <time dateTime={session.created_at}>
                    {new Date(session.created_at).toLocaleString()}
                  </time>
                </p>
                <p className="text-zinc-400">
                  Last active{' '}
                  <time dateTime={session.last_used_at}>
                    {new Date(session.last_used_at).toLocaleString()}
                  </time>
                </p>
              </div>
              {!session.is_current && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void revoke(session.id)}
                  aria-label={`Revoke session signed in ${new Date(session.created_at).toLocaleString()}`}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {revoking === session.id ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data?.items.length === 0 && (
        <p className="text-sm text-zinc-400">No sessions on this page.</p>
      )}
      <div className="flex flex-wrap gap-3 text-sm text-sky-300">
        <button type="button" disabled={disabled} onClick={refetch}>
          Refresh sessions
        </button>
        {cursor && (
          <button type="button" disabled={disabled} onClick={() => setCursor(null)}>
            Newest sessions
          </button>
        )}
        {data?.next_cursor && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setCursor(data.next_cursor ?? null)}
          >
            Older sessions
          </button>
        )}
      </div>
    </div>
  )
}
