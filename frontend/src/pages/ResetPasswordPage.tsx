import { type FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { apiConfirmPasswordReset } from '../api/auth'
import { ROUTES } from '../routes'

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => navigate(ROUTES.login), 3000)
    return () => clearTimeout(timer)
  }, [success, navigate])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const password = String(formData.get('password') ?? '')
    const confirmPassword = String(formData.get('confirm-password') ?? '')

    setError(null)
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      await apiConfirmPasswordReset(token, password)
      setSuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm px-6">
        <h1 className="mb-8 text-center text-2xl font-semibold text-zinc-100">Set new password</h1>

        {success ? (
          <p className="text-center text-sm text-emerald-400">
            Password reset. Redirecting to sign in…
          </p>
        ) : token ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm text-zinc-400" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm text-zinc-400" htmlFor="confirm-password">
                Confirm password
              </label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Reset password'}
            </button>
          </form>
        ) : (
          <p className="text-center text-sm text-red-400">
            Password reset link is missing a token.
          </p>
        )}

        <p className="mt-6 text-center text-sm text-zinc-500">
          Back to{' '}
          <Link to={ROUTES.login} className="text-zinc-300 hover:text-zinc-100">
            sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
