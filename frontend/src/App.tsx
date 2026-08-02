import { type ReactNode, Suspense, useEffect } from 'react'
import { BrowserRouter, Outlet, Route, Routes, useNavigate } from 'react-router'
import { RequireAuth } from './components/auth/RequireAuth'
import { AppShell } from './components/layout/AppShell'
import { LoadingBlock, LoadingScreen } from './components/ui/Spinner'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { InvitePage } from './pages/InvitePage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { RegisterPage } from './pages/RegisterPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { pages, preloadRouteChunks } from './routePreload'
import { ROUTES } from './routes'
import { useAuthStore } from './stores/auth'

const CalendarPage = pages.CalendarPage.Component
const DashboardEditorPage = pages.DashboardEditorPage.Component
const DashboardsPage = pages.DashboardsPage.Component
const ListDetailPage = pages.ListDetailPage.Component
const ListsLayout = pages.ListsLayout.Component
const NotificationsPage = pages.NotificationsPage.Component
const ProfilePage = pages.ProfilePage.Component

function AuthInit({ children }: { children: ReactNode }) {
  const init = useAuthStore((s) => s.init)
  useEffect(() => {
    // The route's chunk downloads while /auth/me is in flight, and init holds the boot
    // screen until both are in hand — so the first route render never suspends.
    void init(preloadRouteChunks(window.location.pathname))
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

  return <LoadingBlock label="Opening your dashboard" />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthInit>
        {/* Every lazy route is behind RequireAuth and suspends at the boundary inside AppShell.
            This one only catches a lazy public route, should one ever be added. */}
        <Suspense fallback={<LoadingScreen label="Loading" />}>
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
                    {/* Inside the shell, so a chunk still downloading fills the content area
                        instead of replacing the whole screen and moving the spinner. */}
                    <Suspense fallback={<LoadingBlock />}>
                      <Outlet />
                    </Suspense>
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

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AuthInit>
    </BrowserRouter>
  )
}
