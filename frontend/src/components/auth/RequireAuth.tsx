import { Navigate, Outlet } from 'react-router-dom'
import { ROUTES } from '../../routes'
import { useAuthStore } from '../../stores/auth'

export function RequireAuth() {
  const status = useAuthStore((s) => s.status)

  if (status === 'loading') {
    return (
      <div
        className="flex h-screen items-center justify-center bg-zinc-950"
        role="status"
        aria-label="Loading authentication"
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-300" />
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <Navigate to={ROUTES.login} replace />
  }

  return <Outlet />
}
