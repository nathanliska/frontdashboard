import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError } from '../api/http'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'

/**
 * Where the link mailed to a new address lands. Confirming is a button, not something the page
 * does on load: a mail scanner or a link preview opening the URL must not spend the link.
 */
export function ConfirmEmailChangePage() {
  const confirmEmailChange = useAuthStore((s) => s.confirmEmailChange)
  const signedIn = useAuthStore((s) => s.status === 'authenticated')
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete.')

  async function handleConfirm() {
    if (!token) return
    setState('busy')
    setError(null)
    try {
      await confirmEmailChange(token)
      setState('done')
    } catch (err) {
      setState('idle')
      const status = err instanceof ApiError ? err.status : null
      // Worded here: a 429 carries no detail, and a dropped connection's message is the browser's.
      if (status === 400)
        setError('That link is invalid or expired. Ask for a new one from your profile.')
      else if (status === 429) setError('Too many attempts. Try again in a minute.')
      else if (status === null) setError('Could not confirm. Check your connection and try again.')
      else setError('Could not confirm. Try again in a moment.')
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm px-6 text-center">
        <h1 className="mb-3 text-2xl font-semibold text-zinc-100">
          {state === 'done' ? 'Email changed' : 'Confirm your new email'}
        </h1>
        <p className="mb-8 text-sm text-zinc-500">
          {state === 'done'
            ? 'Sign in with the new address from now on.'
            : 'This makes the address this link was sent to the one you sign in with.'}
        </p>

        {error && (
          <p className="mb-4 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        {state === 'done' ? null : (
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!token || state === 'busy'}
            className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
          >
            {state === 'busy' ? 'Confirming...' : 'Confirm email'}
          </button>
        )}

        <Link
          to={signedIn ? ROUTES.profile : ROUTES.login}
          className="mt-6 block text-sm text-zinc-500 transition-colors hover:text-zinc-300"
        >
          {signedIn ? 'Back to your profile' : 'Sign in'}
        </Link>
      </div>
    </div>
  )
}
