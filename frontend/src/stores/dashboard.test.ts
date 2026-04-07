import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from './auth'
import type { Dashboard, DashboardSummary } from '../api/dashboards'
import type { SseEvent } from '../hooks/useSSE'
import { useDashboardStore } from './dashboard'

const { apiUpdatePreferences } = vi.hoisted(() => ({
  apiUpdatePreferences: vi.fn(),
}))

const {
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiListDashboards,
  apiRemoveWidget,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
} = vi.hoisted(() => ({
  apiAddWidget: vi.fn(),
  apiCreateDashboard: vi.fn(),
  apiDeleteDashboard: vi.fn(),
  apiGetDashboard: vi.fn(),
  apiListDashboards: vi.fn(),
  apiRemoveWidget: vi.fn(),
  apiUpdateDashboardMeta: vi.fn(),
  apiUpdateLayout: vi.fn(),
  apiUpdateWidget: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

vi.mock('../api/auth', () => ({
  apiChangePassword: vi.fn(),
  apiGetMe: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  apiUpdatePreferences,
  apiUpdateProfile: vi.fn(),
}))

vi.mock('../api/dashboards', () => ({
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiListDashboards,
  apiRemoveWidget,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
}))

vi.mock('./toast', () => ({
  toast: {
    error: toastError,
  },
}))

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    access_description: 'Owned by you',
    is_shared: false,
    is_favorite: false,
    version: 1,
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-05T00:00:00Z',
    ...overrides,
  }
}

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    is_shared: false,
    is_favorite: false,
    layout: [],
    version: 1,
    widgets: [],
    ...overrides,
  }
}

function makeSseEvent(overrides: Partial<SseEvent> = {}): SseEvent {
  return {
    event_id: 1,
    event_type: 'dashboard.updated',
    group_id: null,
    entity_type: 'dashboard',
    entity_id: 'dash-1',
    entity_version: 1,
    actor_id: 'user-1',
    actor_display_name: 'Example User',
    payload: { dashboard_id: 'dash-1' },
    created_at: '2026-04-05T00:00:00Z',
    ...overrides,
  }
}

describe('useDashboardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'test@example.com',
        display_name: 'Test User',
        preferences: {
          home_dashboard_id: 'dash-1',
          favorite_dashboard_ids: [],
        },
      },
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
      listContentVersion: 0,
      calendarContentVersion: 0,
      loading: false,
      loadError: false,
      conflict: false,
    })
  })

  it('updates favorites through user preferences and refreshes summaries', async () => {
    const favoriteSummary = makeSummary({ is_favorite: true })
    apiUpdatePreferences.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      display_name: 'Test User',
      preferences: {
        home_dashboard_id: 'dash-1',
        favorite_dashboard_ids: ['dash-1'],
      },
    })
    apiListDashboards.mockResolvedValue([favoriteSummary])

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().toggleFavorite('dash-1', false)

    expect(apiUpdatePreferences).toHaveBeenCalledWith({ favorite_dashboard_ids: ['dash-1'] })
    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().user?.preferences.favorite_dashboard_ids).toEqual(['dash-1'])
    expect(useDashboardStore.getState().dashboard?.is_favorite).toBe(true)
    expect(useDashboardStore.getState().summaries).toEqual([favoriteSummary])
  })

  it('refreshes summaries and the active dashboard for matching dashboard SSE events', async () => {
    const nextSummary = makeSummary({ name: 'Renamed Dashboard' })
    const nextDashboard = makeDashboard({ name: 'Renamed Dashboard' })

    apiListDashboards.mockResolvedValue([nextSummary])
    apiGetDashboard.mockResolvedValue(nextDashboard)

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().handleDashboardEvent(makeSseEvent())

    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().summaries).toEqual([nextSummary])
    expect(useDashboardStore.getState().dashboard?.name).toBe('Renamed Dashboard')
  })

  it('refreshes only summaries for unrelated dashboard SSE events', async () => {
    const nextSummary = makeSummary({ id: 'dash-2', name: 'New Shared Dashboard' })

    apiListDashboards.mockResolvedValue([makeSummary(), nextSummary])

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.created',
        entity_id: 'dash-2',
        payload: { dashboard_id: 'dash-2' },
      }),
    )

    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().summaries).toEqual([makeSummary(), nextSummary])
  })

  it('refreshes summaries for dashboard events after an empty successful load', async () => {
    const nextSummary = makeSummary({ id: 'dash-2', name: 'New Shared Dashboard' })

    apiListDashboards.mockResolvedValue([nextSummary])

    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: true,
      dashboard: null,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.created',
        entity_id: 'dash-2',
        payload: { dashboard_id: 'dash-2' },
      }),
    )

    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().summaries).toEqual([nextSummary])
  })

  it('debounces summary refreshes across rapid dashboard SSE events', async () => {
    vi.useFakeTimers()

    const nextSummary = makeSummary({ id: 'dash-2', name: 'Burst Update' })
    apiListDashboards.mockResolvedValue([nextSummary])

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: null,
    })

    const first = useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.updated',
        entity_id: 'dash-2',
        payload: { dashboard_id: 'dash-2' },
      }),
    )
    const second = useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_id: 2,
        event_type: 'dashboard.updated',
        entity_id: 'dash-3',
        payload: { dashboard_id: 'dash-3' },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().summaries).toEqual([nextSummary])
    vi.useRealTimers()
  })

  it('handles resync events that do not include a payload', async () => {
    const nextDashboard = makeDashboard({ name: 'Refreshed Dashboard' })

    apiGetDashboard.mockResolvedValue(nextDashboard)

    useDashboardStore.setState({
      dashboard: makeDashboard(),
      summariesLoaded: false,
    })

    await expect(
      useDashboardStore.getState().handleDashboardEvent({ event_type: 'resync' } as SseEvent),
    ).resolves.toBeUndefined()

    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().dashboard?.name).toBe('Refreshed Dashboard')
  })

  it('marks a layout save conflict without replacing the dashboard', async () => {
    const currentDashboard = makeDashboard({ name: 'Current Dashboard' })
    apiUpdateLayout.mockResolvedValue({
      conflict: true,
      detail: 'Version conflict: expected 2, got 1',
    })

    useDashboardStore.setState({
      dashboard: currentDashboard,
      conflict: false,
    })

    await useDashboardStore.getState().saveLayout([])

    expect(apiUpdateLayout).toHaveBeenCalledWith('dash-1', [], 1)
    expect(useDashboardStore.getState().conflict).toBe(true)
    expect(useDashboardStore.getState().dashboard).toEqual(currentDashboard)
  })

  it('clears an existing conflict after a successful layout save', async () => {
    const updatedDashboard = makeDashboard({ name: 'Updated Dashboard', version: 2 })
    apiUpdateLayout.mockResolvedValue({
      conflict: false,
      dashboard: updatedDashboard,
    })

    useDashboardStore.setState({
      dashboard: makeDashboard(),
      conflict: true,
    })

    await useDashboardStore.getState().saveLayout([])

    expect(useDashboardStore.getState().conflict).toBe(false)
    expect(useDashboardStore.getState().dashboard).toEqual(updatedDashboard)
  })
})
