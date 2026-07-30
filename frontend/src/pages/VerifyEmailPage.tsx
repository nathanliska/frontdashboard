import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, apiResendVerification } from '../api/auth'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'

export function getVerificationErrorMessage(err: unknown) {
  if (err instanceof ApiError && err.status === 409) {
    return 'Your email is already verified — please sign in below.'
  }
  if (err instanceof ApiError && err.status === 400) {
    return 'That verification link is invalid or expired. Request a new link below.'
  }
  return err instanceof Error ? err.message : 'Email verification failed'
}

export function VerifyEmailPage() {
  const verifyEmail = useAuthStore((s) => s.verifyEmail)
  const authStatus = useAuthStore((s) => s.status)
  const signedInAs = useAuthStore((s) => (s.status === 'authenticated' ? s.user?.email : null))
  const [confirmedSwitch, setConfirmedSwitch] = useState(false)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const initialEmail = useMemo(() => searchParams.get('email') ?? '', [searchParams])
  const [email, setEmail] = useState(initialEmail)
  const [status, setStatus] = useState<'idle' | 'verifying' | 'verified' | 'resending'>(
    token ? 'verifying' : 'idle',
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Verifying signs you in as whichever account the link belongs to. Auto-running that while
  // someone is already signed in swaps their identity with no acknowledgement, so a signed-in
  // visitor has to confirm first. Waits for `loading` to resolve, or the check races the session.
  const needsSwitchConfirmation = Boolean(token) && Boolean(signedInAs) && !confirmedSwitch

  useEffect(() => {
    if (!token || authStatus === 'loading' || needsSwitchConfirmation) return

    let cancelled = false
    setStatus('verifying')
    setError(null)

    verifyEmail(token)
      .then(() => {
        if (cancelled) return
        setStatus('verified')
        navigate(ROUTES.home, { replace: true })
      })
      .catch((err) => {
        if (cancelled) return
        setStatus('idle')
        setError(getVerificationErrorMessage(err))
      })

    return () => {
      cancelled = true
    }
  }, [authStatus, navigate, needsSwitchConfirmation, token, verifyEmail])

  async function handleResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    setStatus('resending')
    try {
      await apiResendVerification(email)
      setMessage('Verification email sent.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend verification email')
    } finally {
      setStatus('idle')
    }
  }

  if (needsSwitchConfirmation) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="w-full max-w-sm px-6 text-center">
          <h1 className="mb-3 text-2xl font-semibold text-zinc-100">Switch accounts?</h1>
          <p className="mb-8 text-sm text-zinc-400">
            You are signed in as <span className="text-zinc-200">{signedInAs}</span>. Following this
            link verifies the account it was sent to and signs you in as that account instead.
          </p>
          <button
            type="button"
            onClick={() => setConfirmedSwitch(true)}
            className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Continue
          </button>
          <Link
            to={ROUTES.home}
            className="mt-6 block text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Stay signed in as {signedInAs}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm px-6">
        <h1 className="mb-3 text-center text-2xl font-semibold text-zinc-100">Verify your email</h1>
        {/*
          Deliberately vague about which email was sent: signing up with an address that already has
          an account gets this same screen, and says "we sent a verification link" only when one was.
          Naming the email here would put the account-existence oracle back (ADR-011).
        */}
        <p className="mb-8 text-center text-sm text-zinc-500">
          {status === 'verifying' ? (
            'Checking your verification link...'
          ) : initialEmail ? (
            <>
              We sent an email to <span className="text-zinc-300">{initialEmail}</span>. Follow the
              instructions in it before signing in.
            </>
          ) : (
            'Check your inbox and follow the instructions in the email we sent.'
          )}
        </p>

        <form onSubmit={handleResend} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-zinc-400" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {message && <p className="text-sm text-emerald-400">{message}</p>}

          <button
            type="submit"
            disabled={status === 'resending' || status === 'verifying'}
            className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
          >
            {status === 'resending' ? 'Sending...' : 'Resend verification email'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          Already verified?{' '}
          <Link to={ROUTES.login} className="text-zinc-300 hover:text-zinc-100">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
