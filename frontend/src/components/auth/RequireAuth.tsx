import { Navigate, Outlet } from 'react-router'
import { ROUTES } from '../../routes'
import { useAuthStore } from '../../stores/auth'
import { LoadingScreen } from '../ui/Spinner'

export function RequireAuth() {
  const status = useAuthStore((s) => s.status)
  const init = useAuthStore((s) => s.init)

  if (status === 'loading') {
    return <LoadingScreen label="Loading authentication" />
  }

  if (status === 'unreachable') {
    return (
      <div
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-200"
      >
        <p>Could not reach the server.</p>
        <button
          type="button"
          onClick={() => void init()}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
        >
          Try again
        </button>
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <Navigate to={ROUTES.login} replace />
  }

  return <Outlet />
}
