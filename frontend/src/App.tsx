import { lazy, type ReactNode, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router'
import { RequireAuth } from './components/auth/RequireAuth'
import { AppShell } from './components/layout/AppShell'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { InvitePage } from './pages/InvitePage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { ROUTES } from './routes'
import { useAuthStore } from './stores/auth'

const CalendarPage = lazy(() =>
  import('./pages/CalendarPage').then((module) => ({ default: module.CalendarPage })),
)
const DashboardEditorPage = lazy(() =>
  import('./pages/DashboardEditorPage').then((module) => ({ default: module.DashboardEditorPage })),
)
const DashboardsPage = lazy(() =>
  import('./pages/DashboardsPage').then((module) => ({ default: module.DashboardsPage })),
)
const ListDetailPage = lazy(() =>
  import('./pages/ListDetailPage').then((module) => ({ default: module.ListDetailPage })),
)
const ListsLayout = lazy(() =>
  import('./pages/ListsLayout').then((module) => ({ default: module.ListsLayout })),
)
const NotificationsPage = lazy(() =>
  import('./pages/NotificationsPage').then((module) => ({ default: module.NotificationsPage })),
)
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((module) => ({ default: module.ProfilePage })),
)

function RouteFallback() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
    </div>
  )
}

function AuthInit({ children }: { children: ReactNode }) {
  const init = useAuthStore((s) => s.init)
  useEffect(() => {
    void init()
  }, [init])
  return <>{children}</>
}

/**
 * Reads the user's home_dashboard_id preference (already loaded by RequireAuth)
 * and immediately navigates there — no extra API call.
 * Falls back to /dashboards if no preference is set.
 */
function DefaultDashboardRedirect() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)

  useEffect(() => {
    const homeId = user?.preferences?.home_dashboard_id
    navigate(homeId ? ROUTES.dashboard(homeId) : ROUTES.dashboards, { replace: true })
  }, [user, navigate])

  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthInit>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public */}
            <Route path={ROUTES.login} element={<LoginPage />} />
            <Route path={ROUTES.register} element={<RegisterPage />} />
            <Route path={ROUTES.forgotPassword} element={<ForgotPasswordPage />} />
            <Route path={ROUTES.resetPassword} element={<ResetPasswordPage />} />
            <Route path={ROUTES.verifyEmail} element={<VerifyEmailPage />} />
            {/* Public: the code is the credential, and the preview must be readable signed out. */}
            <Route path={ROUTES.invitePattern} element={<InvitePage />} />

            {/* Protected — RequireAuth shows spinner while loading, redirects if unauthed */}
            <Route element={<RequireAuth />}>
              <Route
                element={
                  <AppShell>
                    <Outlet />
                  </AppShell>
                }
              >
                <Route path={ROUTES.home} element={<DefaultDashboardRedirect />} />
                <Route path={ROUTES.dashboards} element={<DashboardsPage />} />
                <Route path={ROUTES.dashboardPattern} element={<DashboardEditorPage />} />
                <Route path={ROUTES.calendar} element={<CalendarPage />} />
                <Route path={ROUTES.lists} element={<ListsLayout />}>
                  <Route path=":listId" element={<ListDetailPage />} />
                </Route>
                <Route path={ROUTES.notifications} element={<NotificationsPage />} />
                <Route path={ROUTES.profile} element={<ProfilePage />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to={ROUTES.home} replace />} />
          </Routes>
        </Suspense>
      </AuthInit>
    </BrowserRouter>
  )
}
