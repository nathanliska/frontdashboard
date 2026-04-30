import { type ReactNode, useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { RequireAuth } from './components/auth/RequireAuth'
import { AppShell } from './components/layout/AppShell'
import { CalendarPage } from './pages/CalendarPage'
import { DashboardEditorPage } from './pages/DashboardEditorPage'
import { DashboardsPage } from './pages/DashboardsPage'
import { ListDetailPage } from './pages/ListDetailPage'
import { ListsLayout } from './pages/ListsLayout'
import { LoginPage } from './pages/LoginPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { PreferencesPage } from './pages/PreferencesPage'
import { ProfilePage } from './pages/ProfilePage'
import { RegisterPage } from './pages/RegisterPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { ROUTES } from './routes'
import { useAuthStore } from './stores/auth'

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
        <Routes>
          {/* Public */}
          <Route path={ROUTES.login} element={<LoginPage />} />
          <Route path={ROUTES.register} element={<RegisterPage />} />
          <Route path={ROUTES.verifyEmail} element={<VerifyEmailPage />} />

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
              <Route path={ROUTES.preferences} element={<PreferencesPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to={ROUTES.home} replace />} />
        </Routes>
      </AuthInit>
    </BrowserRouter>
  )
}
