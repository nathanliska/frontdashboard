import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, apiResendVerification } from '../api/auth'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'

/**
 * The backend's resend cooldown (`_RESEND_COOLDOWN` in routers/auth.py). The server enforces it;
 * this only keeps the control from offering a send the server would skip.
 */
export const RESEND_COOLDOWN_SECONDS = 60

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
  const [alreadyVerified, setAlreadyVerified] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  // Verifying signs you in as the link's account, so a signed-in visitor confirms first rather
  // than having their identity swapped silently.
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
        setAlreadyVerified(err instanceof ApiError && err.status === 409)
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
      // Worded for every case the server answers alike: no account, already verified, or a send
      // skipped inside the cooldown — whose earlier link is still on its way (ADR-011).
      setMessage('If that address needs verifying, a link is on its way. Check spam too.')
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429)
        setError('Too many requests. Try again in a minute.')
      else setError(err instanceof Error ? err.message : 'Failed to resend verification email')
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
        {!alreadyVerified && (
          <p className="mb-8 text-center text-sm text-zinc-500">
            {status === 'verifying' ? (
              'Checking your verification link...'
            ) : initialEmail ? (
              <>
                We sent an email to <span className="text-zinc-300">{initialEmail}</span>. Follow
                the instructions in it before signing in.
              </>
            ) : (
              'Check your inbox and follow the instructions in the email we sent.'
            )}
          </p>
        )}

        {error && <p className="mb-4 text-center text-sm text-red-400">{error}</p>}

        {alreadyVerified ? (
          <Link
            to={ROUTES.login}
            className="block w-full rounded-md bg-zinc-100 px-4 py-2 text-center text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
          >
            Sign in
          </Link>
        ) : (
          <>
            <form onSubmit={handleResend} className="space-y-3 text-center">
              {/* The address is already known after signing up; asking again would only invite a typo. */}
              {!initialEmail && (
                <div className="text-left">
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
              )}

              {message && <p className="text-sm text-emerald-400">{message}</p>}

              <p className="text-sm text-zinc-500">
                {!error && "Didn't get it? "}
                <button
                  type="submit"
                  disabled={status === 'resending' || status === 'verifying' || cooldown > 0}
                  className="text-zinc-300 underline-offset-4 transition-colors hover:text-zinc-100 hover:underline disabled:text-zinc-500 disabled:no-underline"
                >
                  {status === 'resending'
                    ? 'Sending…'
                    : cooldown > 0
                      ? `Send another in ${cooldown}s`
                      : 'Send another'}
                </button>
              </p>
            </form>

            <p className="mt-6 text-center text-sm text-zinc-500">
              Already verified?{' '}
              <Link to={ROUTES.login} className="text-zinc-300 hover:text-zinc-100">
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
