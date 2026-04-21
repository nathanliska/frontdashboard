import { type ReactNode, useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { RequireAuth } from './components/auth/RequireAuth'
import { AppShell } from './components/layout/AppShell'
import { CalendarPage } from './pages/CalendarPage'
import { DashboardEditorPage } from './pages/DashboardEditorPage'
import { DashboardsPage } from './pages/DashboardsPage'
import { ListsPage } from './pages/ListsPage'
import { LoginPage } from './pages/LoginPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { PreferencesPage } from './pages/PreferencesPage'
import { ProfilePage } from './pages/ProfilePage'
import { RegisterPage } from './pages/RegisterPage'
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
    navigate(homeId ? `/dashboard/${homeId}` : '/dashboards', { replace: true })
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
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Protected — RequireAuth shows spinner while loading, redirects if unauthed */}
          <Route element={<RequireAuth />}>
            <Route
              element={
                <AppShell>
                  <Outlet />
                </AppShell>
              }
            >
              <Route path="/" element={<DefaultDashboardRedirect />} />
              <Route path="/dashboards" element={<DashboardsPage />} />
              <Route path="/dashboard/:id" element={<DashboardEditorPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/lists" element={<ListsPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/preferences" element={<PreferencesPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthInit>
    </BrowserRouter>
  )
}
