import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard, DashboardSummary } from '../api/dashboards'
import type { SseEvent } from '../hooks/useSSE'
import {
  __resetPendingDashboardMutationsForTests,
  recordPendingDashboardMutation,
} from '../utils/dashboard/dashboardMutation'
import { useAuthStore } from './auth'
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
    archived: false,
    access_description: 'Owned by you',
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
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
    archived: false,
    is_shared: false,
    can_edit: true,
    can_manage_shares: true,
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
    __resetPendingDashboardMutationsForTests()
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
      loading: false,
      loadError: false,
      conflict: false,
    })
  })

  it('updates favorites through user preferences and updates summaries in-place', async () => {
    apiUpdatePreferences.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      display_name: 'Test User',
      preferences: {
        home_dashboard_id: 'dash-1',
        favorite_dashboard_ids: ['dash-1'],
      },
    })

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().toggleFavorite('dash-1', false)

    expect(apiUpdatePreferences).toHaveBeenCalledWith({ favorite_dashboard_ids: ['dash-1'] })
    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.preferences.favorite_dashboard_ids).toEqual(['dash-1'])
    expect(useDashboardStore.getState().dashboard?.is_favorite).toBe(true)
    expect(useDashboardStore.getState().summaries).toEqual([makeSummary({ is_favorite: true })])
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

  it('updates summaries locally for layout-only dashboard events without refetching', async () => {
    useDashboardStore.setState({
      summaries: [
        makeSummary({ id: 'dash-1', updated_at: '2026-04-05T00:00:00Z', version: 1 }),
        makeSummary({ id: 'dash-2', name: 'Older Dashboard', updated_at: '2026-04-04T00:00:00Z' }),
      ],
      summariesLoaded: true,
      dashboard: null,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_id: 'dash-1',
        entity_version: 2,
        created_at: '2026-04-06T00:00:00Z',
        payload: {
          dashboard_id: 'dash-1',
          changed_fields: ['layout'],
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().summaries[0]).toMatchObject({
      id: 'dash-1',
      version: 2,
      updated_at: '2026-04-06T00:00:00Z',
    })
  })

  it('leaves summaries unchanged for widget-only dashboard events without refetching', async () => {
    const originalSummary = makeSummary({ updated_at: '2026-04-05T00:00:00Z', version: 3 })
    useDashboardStore.setState({
      summaries: [originalSummary],
      summariesLoaded: true,
      dashboard: null,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        created_at: '2026-04-06T00:00:00Z',
        payload: {
          dashboard_id: 'dash-1',
          widget_id: 'widget-1',
          changed_fields: ['widgets'],
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().summaries[0]).toEqual(originalSummary)
  })

  it('queues a forced summaries reload when a previous summaries request is already in flight', async () => {
    let resolveFirstRequest!: (value: DashboardSummary[]) => void
    const refreshedSummaries = [makeSummary({ id: 'dash-2', name: 'Shared Later' })]

    apiListDashboards
      .mockImplementationOnce(
        () =>
          new Promise<DashboardSummary[]>((resolve) => {
            resolveFirstRequest = resolve
          }),
      )
      .mockResolvedValueOnce(refreshedSummaries)

    const initialLoad = useDashboardStore.getState().loadSummaries()
    const forcedReload = useDashboardStore.getState().loadSummaries(true)

    resolveFirstRequest([])
    await Promise.all([initialLoad, forcedReload])

    expect(apiListDashboards).toHaveBeenCalledTimes(2)
    expect(useDashboardStore.getState().summaries).toEqual(refreshedSummaries)
  })

  it('reloads the active dashboard after dashboard share changes', async () => {
    apiListDashboards.mockResolvedValue([makeSummary()])
    apiGetDashboard.mockResolvedValue(makeDashboard())

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_removed',
        payload: {
          dashboard_id: 'dash-1',
        },
      }),
    )

    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().dashboard?.id).toBe('dash-1')
  })

  it('still reloads summaries and the active dashboard for local share echoes', async () => {
    recordPendingDashboardMutation('share-mut-1')
    apiListDashboards.mockResolvedValue([makeSummary({ is_shared: true })])
    apiGetDashboard.mockResolvedValue(makeDashboard({ is_shared: true }))

    useDashboardStore.setState({
      summaries: [makeSummary({ is_shared: false })],
      summariesLoaded: true,
      dashboard: makeDashboard({ is_shared: false }),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_added',
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: 'share-mut-1',
        },
      }),
    )

    expect(apiListDashboards).toHaveBeenCalledTimes(1)
    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().summaries[0]?.is_shared).toBe(true)
    expect(useDashboardStore.getState().dashboard?.is_shared).toBe(true)
  })

  it('skips active dashboard refetch for layout-only events when the local dashboard is already current', async () => {
    useDashboardStore.setState({
      summaries: [makeSummary({ version: 1 })],
      summariesLoaded: true,
      dashboard: makeDashboard({ version: 2 }),
      loadError: false,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_id: 'dash-1',
        entity_version: 2,
        created_at: '2026-04-06T00:00:00Z',
        payload: {
          dashboard_id: 'dash-1',
          changed_fields: ['layout'],
        },
      }),
    )

    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard?.version).toBe(2)
    expect(useDashboardStore.getState().summaries[0]).toMatchObject({
      version: 2,
      updated_at: '2026-04-06T00:00:00Z',
    })
  })

  it('reloads the active dashboard for layout-only events when the local dashboard is stale', async () => {
    const refreshedDashboard = makeDashboard({ version: 3, name: 'Fresh Layout' })
    apiGetDashboard.mockResolvedValue(refreshedDashboard)

    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({ version: 2 }),
      loadError: false,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_id: 'dash-1',
        entity_version: 3,
        payload: {
          dashboard_id: 'dash-1',
          changed_fields: ['layout'],
        },
      }),
    )

    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().dashboard).toEqual(refreshedDashboard)
  })

  it('skips the in-flight layout self-echo reload while saving layout', async () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111')
    let resolveLayoutUpdate!: (value: { conflict: false; dashboard: Dashboard }) => void
    const nextLayout = [{ i: 'widget-1', x: 1, y: 0, w: 4, h: 3 }]

    apiUpdateLayout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLayoutUpdate = resolve
        }),
    )

    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({ version: 1 }),
      loadError: false,
    })

    const savePromise = useDashboardStore.getState().saveLayout(nextLayout)
    await Promise.resolve()

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: '11111111-1111-4111-8111-111111111111',
          changed_fields: ['layout'],
        },
      }),
    )

    expect(apiGetDashboard).not.toHaveBeenCalled()

    resolveLayoutUpdate({
      conflict: false,
      dashboard: makeDashboard({ version: 2, layout: nextLayout }),
    })
    await savePromise
    randomUuidSpy.mockRestore()
  })

  it('skips the widget self-echo reload after updating widget config locally', async () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('22222222-2222-4222-8222-222222222222')
    const updatedWidget = {
      id: 'widget-1',
      dashboard_id: 'dash-1',
      widget_type: 'calendar',
      widget_version: 2,
      config: { view: 'week' },
      resource_type: null,
      resource_id: null,
      created_at: '2026-04-05T00:00:00Z',
      updated_at: '2026-04-06T00:00:00Z',
    }

    apiUpdateWidget.mockResolvedValue(updatedWidget)

    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({
        widgets: [
          {
            ...updatedWidget,
            widget_version: 1,
            config: { view: 'month' },
          },
        ],
      }),
    })

    await useDashboardStore.getState().updateWidget('widget-1', { view: 'week' })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: '22222222-2222-4222-8222-222222222222',
          changed_fields: ['widgets'],
        },
      }),
    )

    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard?.widgets[0]?.config).toEqual({ view: 'week' })
    randomUuidSpy.mockRestore()
  })

  it('skips summary and dashboard refetches for local rename echoes', async () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('33333333-3333-4333-8333-333333333333')
    const renamedSummary = makeSummary({
      name: 'Renamed Dashboard',
      version: 2,
    })

    apiUpdateDashboardMeta.mockResolvedValue(renamedSummary)

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().renameDashboard('dash-1', 'Renamed Dashboard')

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: '33333333-3333-4333-8333-333333333333',
          changed_fields: ['name'],
          name: 'Renamed Dashboard',
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().summaries[0]?.name).toBe('Renamed Dashboard')
    expect(useDashboardStore.getState().dashboard?.name).toBe('Renamed Dashboard')
    randomUuidSpy.mockRestore()
  })

  it('surfaces access loss when a share change removes the active dashboard from view', async () => {
    apiListDashboards.mockResolvedValue([])
    apiGetDashboard.mockRejectedValue(
      Object.assign(new Error('Dashboard not found'), {
        status: 404,
      }),
    )

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
      loadError: false,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_removed',
        payload: {
          dashboard_id: 'dash-1',
        },
      }),
    )

    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(useDashboardStore.getState().loadError).toBe(true)
  })

  it('queues a follow-up background dashboard reload when a previous request is already in flight', async () => {
    let resolveFirstRequest!: (value: Dashboard) => void

    apiGetDashboard
      .mockImplementationOnce(
        () =>
          new Promise<Dashboard>((resolve) => {
            resolveFirstRequest = resolve
          }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Dashboard not found'), {
          status: 404,
        }),
      )

    useDashboardStore.setState({
      dashboard: makeDashboard(),
      loadError: false,
    })

    const initialLoad = useDashboardStore.getState().loadDashboard('dash-1', {
      background: true,
    })
    const followUpLoad = useDashboardStore.getState().loadDashboard('dash-1', {
      background: true,
      surfaceAccessLoss: true,
    })

    resolveFirstRequest(makeDashboard({ name: 'Stale Dashboard' }))
    await Promise.all([initialLoad, followUpLoad])

    expect(apiGetDashboard).toHaveBeenCalledTimes(2)
    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(useDashboardStore.getState().loadError).toBe(true)
  })

  it('ignores stale dashboard responses after navigating to a different dashboard mid-load', async () => {
    let resolveFirstRequest!: (value: Dashboard) => void
    let resolveSecondRequest!: (value: Dashboard) => void

    apiGetDashboard.mockImplementation((id: string) => {
      if (id === 'dash-1') {
        return new Promise<Dashboard>((resolve) => {
          resolveFirstRequest = resolve
        })
      }

      return new Promise<Dashboard>((resolve) => {
        resolveSecondRequest = resolve
      })
    })

    const firstLoad = useDashboardStore.getState().loadDashboard('dash-1')
    const secondLoad = useDashboardStore.getState().loadDashboard('dash-2')

    resolveFirstRequest(makeDashboard({ id: 'dash-1', name: 'Old Dashboard' }))
    await firstLoad

    expect(useDashboardStore.getState().loading).toBe(true)
    expect(useDashboardStore.getState().dashboard).toBeNull()

    resolveSecondRequest(makeDashboard({ id: 'dash-2', name: 'Current Dashboard' }))
    await secondLoad

    expect(useDashboardStore.getState().dashboard?.id).toBe('dash-2')
    expect(useDashboardStore.getState().dashboard?.name).toBe('Current Dashboard')
    expect(useDashboardStore.getState().loading).toBe(false)
    expect(useDashboardStore.getState().loadError).toBe(false)
  })

  it('ignores stale dashboard load errors after navigating to a different dashboard mid-load', async () => {
    let rejectFirstRequest!: (error: Error) => void
    let resolveSecondRequest!: (value: Dashboard) => void

    apiGetDashboard.mockImplementation((id: string) => {
      if (id === 'dash-1') {
        return new Promise<Dashboard>((_, reject) => {
          rejectFirstRequest = reject as (error: Error) => void
        })
      }

      return new Promise<Dashboard>((resolve) => {
        resolveSecondRequest = resolve
      })
    })

    const firstLoad = useDashboardStore.getState().loadDashboard('dash-1')
    const secondLoad = useDashboardStore.getState().loadDashboard('dash-2')

    rejectFirstRequest(Object.assign(new Error('Dashboard not found'), { status: 404 }))
    await firstLoad

    expect(useDashboardStore.getState().loading).toBe(true)
    expect(useDashboardStore.getState().loadError).toBe(false)
    expect(useDashboardStore.getState().dashboard).toBeNull()

    resolveSecondRequest(makeDashboard({ id: 'dash-2', name: 'Current Dashboard' }))
    await secondLoad

    expect(useDashboardStore.getState().dashboard?.id).toBe('dash-2')
    expect(useDashboardStore.getState().loading).toBe(false)
    expect(useDashboardStore.getState().loadError).toBe(false)
  })

  it('surfaces access loss on resync when the active dashboard is no longer accessible', async () => {
    apiGetDashboard.mockRejectedValue(
      Object.assign(new Error('Dashboard not found'), {
        status: 404,
      }),
    )

    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard(),
      loadError: false,
    })

    await expect(
      useDashboardStore.getState().handleDashboardEvent({ event_type: 'resync' } as SseEvent),
    ).resolves.toBeUndefined()

    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(useDashboardStore.getState().loadError).toBe(true)
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

    expect(apiUpdateLayout).toHaveBeenCalledWith(
      'dash-1',
      [],
      1,
      expect.objectContaining({ clientMutationId: expect.any(String) }),
    )
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
