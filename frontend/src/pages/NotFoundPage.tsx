import { Link, useLocation } from 'react-router'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'

/** Unknown URLs land here. The destination waits for auth to resolve: `/login` is a dead end for a
 *  signed-in user, `/dashboards` bounces a signed-out one straight back. */
export function NotFoundPage() {
  const { pathname } = useLocation()
  const status = useAuthStore((s) => s.status)
  const authenticated = status === 'authenticated'

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-3 text-2xl font-semibold text-zinc-100">Page not found</h1>
        <p className="mb-2 text-sm text-zinc-400">
          Nothing here answers to <code className="text-zinc-300">{pathname}</code>.
        </p>
        <p className="mb-8 text-sm text-zinc-500">
          If you followed a link from an email, it may have been cut short — copying the whole
          address into the address bar usually fixes it.
        </p>

        {/* Reserved height, so the button appearing does not shift the text above it. */}
        <div className="h-10">
          {status !== 'loading' && (
            <Link
              to={authenticated ? ROUTES.dashboards : ROUTES.login}
              className="inline-block rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
            >
              {authenticated ? 'Back to dashboards' : 'Go to sign in'}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
