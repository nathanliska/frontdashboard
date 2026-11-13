import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard } from '../../api/dashboards'
import { ApiError } from '../../api/http'
import { RESYNC_SIGNAL } from '../../hooks/useSSE'
import { beginDashboardStoreTest } from '../../test/dashboard-store'
import {
  apiGetDashboard,
  apiListDashboards,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
} from '../../test/dashboard-store-mocks'
import { makeDashboard, makeDashboardSummary, makeSseEvent } from '../../test/fixtures'
import { CLIENT_INSTANCE_ID } from '../../utils/shared/clientInstance'
import { resetDashboardData, useDashboardStore } from '../dashboard'

vi.mock(
  '../../resources/listData',
  async () => (await import('../../test/dashboard-store-mocks')).listDataMock,
)
vi.mock(
  '../../api/auth',
  async () => (await import('../../test/dashboard-store-mocks')).authApiMock,
)
vi.mock(
  '../../api/dashboards',
  async () => (await import('../../test/dashboard-store-mocks')).dashboardsApiMock,
)
vi.mock('../toast', async () => (await import('../../test/dashboard-store-mocks')).toastStoreMock())

describe('useDashboardStore events', () => {
  beforeEach(beginDashboardStoreTest)

  it('refreshes summaries and the active dashboard for matching dashboard SSE events', async () => {
    const nextSummary = makeDashboardSummary({ name: 'Renamed Dashboard' })
    const nextDashboard = makeDashboard({ name: 'Renamed Dashboard' })

    apiListDashboards.mockResolvedValue([nextSummary])
    apiGetDashboard.mockResolvedValue(nextDashboard)

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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
        makeDashboardSummary({ id: 'dash-1', updated_at: '2026-04-05T00:00:00Z', version: 1 }),
        makeDashboardSummary({
          id: 'dash-2',
          name: 'Older Dashboard',
          updated_at: '2026-04-04T00:00:00Z',
        }),
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
    const originalSummary = makeDashboardSummary({ updated_at: '2026-04-05T00:00:00Z', version: 3 })
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

  it('reloads the active dashboard after dashboard share changes', async () => {
    apiListDashboards.mockResolvedValue([makeDashboardSummary()])
    apiGetDashboard.mockResolvedValue(makeDashboard())

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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

  it('suppresses all reloads for a local share role-change echo (share_updated)', async () => {
    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_updated',
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          origin_client_id: CLIENT_INSTANCE_ID,
        },
      }),
    )

    // A role change alters nothing this client caches — no summaries or dashboard refetch.
    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetDashboard).not.toHaveBeenCalled()
  })

  it('still reloads summaries and the active dashboard for local share echoes', async () => {
    apiListDashboards.mockResolvedValue([makeDashboardSummary({ is_shared: true })])
    apiGetDashboard.mockResolvedValue(makeDashboard({ is_shared: true }))

    useDashboardStore.setState({
      summaries: [makeDashboardSummary({ is_shared: false })],
      summariesLoaded: true,
      dashboard: makeDashboard({ is_shared: false }),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_added',
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          origin_client_id: CLIENT_INSTANCE_ID,
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
      summaries: [makeDashboardSummary({ version: 1 })],
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
          origin_client_id: CLIENT_INSTANCE_ID,
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
  })

  it('skips the widget self-echo reload after updating widget config locally', async () => {
    const updatedWidget = {
      id: 'widget-1',
      dashboard_id: 'dash-1',
      widget_type: 'calendar' as const,
      config: { view: 'week' },
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
          origin_client_id: CLIENT_INSTANCE_ID,
          changed_fields: ['widgets'],
        },
      }),
    )

    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard?.widgets[0]?.config).toEqual({ view: 'week' })
  })

  it('skips summary and dashboard refetches for local rename echoes', async () => {
    const renamedSummary = makeDashboardSummary({
      name: 'Renamed Dashboard',
      version: 2,
    })

    apiUpdateDashboardMeta.mockResolvedValue(renamedSummary)

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().renameDashboard('dash-1', 'Renamed Dashboard')

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          origin_client_id: CLIENT_INSTANCE_ID,
          changed_fields: ['name'],
          name: 'Renamed Dashboard',
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().summaries[0]?.name).toBe('Renamed Dashboard')
    expect(useDashboardStore.getState().dashboard?.name).toBe('Renamed Dashboard')
  })

  it('surfaces access loss when a share change removes the active dashboard from view', async () => {
    apiListDashboards.mockResolvedValue([])
    apiGetDashboard.mockRejectedValue(new ApiError('Dashboard not found', 404))

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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

  it('surfaces access loss on resync when the active dashboard is no longer accessible', async () => {
    apiGetDashboard.mockRejectedValue(new ApiError('Dashboard not found', 404))

    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard(),
      loadError: false,
    })

    await expect(
      useDashboardStore.getState().handleDashboardEvent(RESYNC_SIGNAL),
    ).resolves.toBeUndefined()

    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(useDashboardStore.getState().loadError).toBe(true)
  })

  it('refreshes only summaries for unrelated dashboard SSE events', async () => {
    const nextSummary = makeDashboardSummary({ id: 'dash-2', name: 'New Shared Dashboard' })

    apiListDashboards.mockResolvedValue([makeDashboardSummary(), nextSummary])

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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
    expect(useDashboardStore.getState().summaries).toEqual([makeDashboardSummary(), nextSummary])
  })

  it('refreshes summaries for dashboard events after an empty successful load', async () => {
    const nextSummary = makeDashboardSummary({ id: 'dash-2', name: 'New Shared Dashboard' })

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

    const nextSummary = makeDashboardSummary({ id: 'dash-2', name: 'Burst Update' })
    apiListDashboards.mockResolvedValue([nextSummary])

    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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

  it('settles a pending debounced summaries-refresh promise on reset instead of hanging', async () => {
    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      dashboard: null,
    })

    // Not awaited yet: handleDashboardEvent runs synchronously up to its await on the debounce
    // promise, so that promise already exists in module state when this call returns.
    const handling = useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.updated',
        entity_id: 'dash-2',
        payload: { dashboard_id: 'dash-2' },
      }),
    )

    resetDashboardData() // account boundary while the debounce timer is still pending

    // The debounce timer is cleared by the reset and will never fire, so without the
    // fix `handling` would hang forever awaiting the never-settled promise. Guard
    // with a short race so a regression fails fast instead of timing out the suite.
    await expect(
      Promise.race([
        handling,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('handleDashboardEvent hung after reset')), 500),
        ),
      ]),
    ).resolves.toBeUndefined()
  })

  it('handles resync events that do not include a payload', async () => {
    const nextDashboard = makeDashboard({ name: 'Refreshed Dashboard' })

    apiGetDashboard.mockResolvedValue(nextDashboard)

    useDashboardStore.setState({
      dashboard: makeDashboard(),
      summariesLoaded: false,
    })

    await expect(
      useDashboardStore.getState().handleDashboardEvent(RESYNC_SIGNAL),
    ).resolves.toBeUndefined()

    expect(apiGetDashboard).toHaveBeenCalledWith('dash-1')
    expect(useDashboardStore.getState().dashboard?.name).toBe('Refreshed Dashboard')
  })

  it("patches a widget's config from someone else's event without reloading the dashboard", async () => {
    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({
        version: 4,
        widgets: [
          {
            id: 'widget-1',
            dashboard_id: 'dash-1',
            widget_type: 'calendar',
            config: { view: 'month' },
            created_at: '2026-04-05T00:00:00Z',
            updated_at: '2026-04-05T00:00:00Z',
          },
        ],
      }),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        actor_id: 'someone-else',
        entity_version: 4,
        payload: {
          dashboard_id: 'dash-1',
          widget_id: 'widget-1',
          config: { view: 'week' },
          changed_fields: ['widgets'],
        },
      }),
    )

    // Asserting the config is right would pass whether it was patched or refetched, so the load
    // count is the real assertion here.
    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard?.widgets[0].config).toEqual({ view: 'week' })
    // Untouched on purpose: only layout writes move the version, and PUT /layout compares it to
    // detect a concurrent edit. Advancing it here would let a stale layout save look current.
    expect(useDashboardStore.getState().dashboard?.version).toBe(4)
  })

  it('reloads rather than patching when a widget event also changed the layout', async () => {
    apiGetDashboard.mockResolvedValue(makeDashboard({ version: 5 }))
    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({
        version: 4,
        widgets: [
          {
            id: 'widget-1',
            dashboard_id: 'dash-1',
            widget_type: 'calendar',
            config: { view: 'month' },
            created_at: '2026-04-05T00:00:00Z',
            updated_at: '2026-04-05T00:00:00Z',
          },
        ],
      }),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        actor_id: 'someone-else',
        entity_version: 5,
        payload: {
          dashboard_id: 'dash-1',
          widget_id: 'widget-1',
          config: { view: 'week' },
          changed_fields: ['widgets', 'layout'],
        },
      }),
    )

    expect(apiGetDashboard).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst of layout events into a single dashboard reload', async () => {
    apiGetDashboard.mockResolvedValue(makeDashboard({ version: 9 }))
    useDashboardStore.setState({
      summariesLoaded: false,
      dashboard: makeDashboard({ version: 1 }),
    })

    await Promise.all(
      [2, 3, 4, 5].map((version) =>
        useDashboardStore.getState().handleDashboardEvent(
          makeSseEvent({
            actor_id: 'someone-else',
            entity_version: version,
            payload: { dashboard_id: 'dash-1', changed_fields: ['layout', 'widgets'] },
          }),
        ),
      ),
    )

    expect(apiGetDashboard).toHaveBeenCalledTimes(1)
  })
})
