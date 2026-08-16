import { vi } from 'vitest'
import { type DashboardState, useDashboardStore } from '../stores/dashboard'

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
