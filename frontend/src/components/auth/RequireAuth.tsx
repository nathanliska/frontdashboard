import { Navigate, Outlet } from 'react-router'
import { ROUTES } from '../../routes'
import { useAuthStore } from '../../stores/auth'
import { LoadingScreen } from '../ui/Spinner'

export function RequireAuth() {
  const status = useAuthStore((s) => s.status)

  if (status === 'loading') {
    return <LoadingScreen label="Loading authentication" />
  }

  if (status === 'unauthenticated') {
    return <Navigate to={ROUTES.login} replace />
  }

  return <Outlet />
}
