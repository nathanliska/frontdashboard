import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { apiAcceptInvite, apiPreviewInvite, type InvitePreviewResponse } from '../api/invites'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'

/**
 * Where an invite link lands. The code in the URL is the credential, so the preview is readable
 * signed out — someone has to see what they are being invited to before deciding to sign up.
 *
 * Redeeming is a deliberate POST behind the Accept button; merely opening the link never consumes
 * it, which is what keeps message-preview crawlers from burning invites.
 */
export function InvitePage() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const authStatus = useAuthStore((s) => s.status)
  const loadSummaries = useDashboardStore((s) => s.loadSummaries)
  const [preview, setPreview] = useState<InvitePreviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    if (!code) return
    let cancelled = false

    apiPreviewInvite(code)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'This invite link is no longer valid.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [code])

  // Survives the sign-in/registration round trip so the link doesn't have to be reopened by hand.
  // Same-browser only by design — a code is not something to persist any longer than necessary.
  useEffect(() => {
    if (code && !user) sessionStorage.setItem('pendingInviteCode', code)
  }, [code, user])

  async function handleAccept() {
    setAccepting(true)
    setError(null)
    try {
      const result = await apiAcceptInvite(code)
      sessionStorage.removeItem('pendingInviteCode')
      // The new dashboard has to exist in the store before we navigate into it.
      await loadSummaries(true)
      navigate(ROUTES.dashboard(result.dashboard_id), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This invite link is no longer valid.')
      setAccepting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm px-6 text-center">
        {error ? (
          <>
            <h1 className="mb-3 text-2xl font-semibold text-zinc-100">Invite unavailable</h1>
            <p className="mb-8 text-sm text-zinc-500">{error}</p>
            <Link
              to={user ? ROUTES.dashboards : ROUTES.login}
              className="inline-block rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
            >
              {user ? 'Go to your dashboards' : 'Sign in'}
            </Link>
          </>
        ) : !preview ? (
          <p className="text-sm text-zinc-500">Checking this invite…</p>
        ) : (
          <>
            <h1 className="mb-3 text-2xl font-semibold text-zinc-100">{preview.dashboard_name}</h1>
            <p className="mb-8 text-sm text-zinc-500">
              <span className="text-zinc-300">{preview.invited_by}</span> invited you to this
              dashboard as {preview.role === 'editor' ? 'an editor' : 'a viewer'}.
            </p>

            {user ? (
              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={accepting}
                className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
              >
                {accepting ? 'Joining…' : 'Accept invite'}
              </button>
            ) : authStatus === 'loading' ? (
              <p className="text-sm text-zinc-500">Checking your session…</p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-zinc-400">Sign in or create an account to accept.</p>
                <div className="flex gap-2">
                  <Link
                    to={ROUTES.login}
                    className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
                  >
                    Sign in
                  </Link>
                  <Link
                    to={ROUTES.register}
                    className="flex-1 rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-500"
                  >
                    Create account
                  </Link>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
