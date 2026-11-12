import { vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { type DashboardState, resetDashboardData, useDashboardStore } from '../stores/dashboard'
import { signIn } from './signIn'

/**
 * Resets the dashboard store to an inert, fully-stubbed state.
 *
 * Every action is a `vi.fn()` rather than the real implementation, so a component that fires one
 * during a render fails on the assertion instead of reaching the network. Pass `overrides` for the
 * slice the test actually cares about — anything omitted keeps the empty-but-loaded default, which
 * is what most page tests want (no spinner, no fetch, no data).
 */
export function stubDashboardStore(overrides: Partial<DashboardState> = {}): void {
  useDashboardStore.setState({
    summaries: [],
    summariesLoaded: true,
    summariesLoading: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,
    loadSummaries: vi.fn().mockResolvedValue(undefined),
    createDashboard: vi.fn(),
    deleteDashboard: vi.fn(),
    leaveDashboard: vi.fn(),
    toggleFavorite: vi.fn(),
    renameDashboard: vi.fn(),
    loadDashboard: vi.fn(),
    saveLayout: vi.fn(),
    addWidget: vi.fn(),
    removeWidget: vi.fn(),
    updateWidget: vi.fn(),
    handleDashboardEvent: vi.fn(),
    handleContentEvent: vi.fn(),
    resolveConflict: vi.fn(),
    ...overrides,
  })
}

/** The dashboard store's own tests start here: real actions, a signed-in user, no held data. */
export function beginDashboardStoreTest(): void {
  vi.clearAllMocks()
  // Clear module-level load/layout-drain state so an in-flight drain from a prior test can't leak.
  resetDashboardData()
  signIn({
    email: 'test@example.com',
    display_name: 'Test User',
    preferences: { home_dashboard_id: 'dash-1', favorite_dashboard_ids: [] },
  })
  useAuthStore.setState({
    init: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    updatePreferences: vi.fn(),
    updateProfile: vi.fn(),
    changePassword: vi.fn(),
  })
  useDashboardStore.setState({
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,
  })
}
