import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard, DashboardSummary, TrashedDashboard } from '../api/dashboards'
import { RESYNC_SIGNAL, type SseEvent } from '../hooks/useSSE'
import {
  __resetPendingDashboardMutationsForTests,
  consumePendingDashboardMutation,
  recordPendingDashboardMutation,
} from '../utils/dashboard/dashboardMutation'
import { useAuthStore } from './auth'
import { resetDashboardData, useDashboardStore } from './dashboard'

const { apiUpdatePreferences } = vi.hoisted(() => ({
  apiUpdatePreferences: vi.fn(),
}))

const {
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiGetTrash,
  apiListDashboards,
  apiRemoveWidget,
  apiRestoreDashboard,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
} = vi.hoisted(() => ({
  apiAddWidget: vi.fn(),
  apiCreateDashboard: vi.fn(),
  apiDeleteDashboard: vi.fn(),
  apiGetDashboard: vi.fn(),
  apiGetTrash: vi.fn(),
  apiListDashboards: vi.fn(),
  apiRemoveWidget: vi.fn(),
  apiRestoreDashboard: vi.fn(),
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
  apiGetTrash,
  apiListDashboards,
  apiRemoveWidget,
  apiRestoreDashboard,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
}))

vi.mock('./toast', async () => (await import('../test/toast')).toastMock({ error: toastError }))

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
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

function makeTrashed(overrides: Partial<TrashedDashboard> = {}): TrashedDashboard {
  return {
    id: 'dash-9',
    name: 'Old Dashboard',
    deleted_at: '2026-04-05T00:00:00Z',
    purge_at: '2026-05-05T00:00:00Z',
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
    // Clear module-level load/layout-drain state so an in-flight drain from a prior test can't leak.
    resetDashboardData()
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
    expect(useAuthStore.getState().user?.preferences?.favorite_dashboard_ids).toEqual(['dash-1'])
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

  it('does not let a stale in-flight summaries load null out a newer session load handle', async () => {
    let resolveA!: (v: DashboardSummary[]) => void
    let resolveB!: (v: DashboardSummary[]) => void

    apiListDashboards
      .mockImplementationOnce(
        () =>
          new Promise<DashboardSummary[]>((resolve) => {
            resolveA = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DashboardSummary[]>((resolve) => {
            resolveB = resolve
          }),
      )
      // Fallback used only if the bug reappears and a spurious 3rd fetch is made.
      .mockResolvedValue([])

    // Session A starts a summaries load (call #1) and never gets to finish before
    // the boundary — its `finally` resolves only after we've moved on to session B.
    const loadA = useDashboardStore.getState().loadSummaries()

    resetDashboardData() // account boundary — bumps sessionGeneration, clears the handle

    // Session B starts its own summaries load (call #2), which is still in flight.
    const loadB = useDashboardStore.getState().loadSummaries()

    // Now let A's stale request resolve and its `finally` run.
    resolveA([])
    await loadA

    // A forced reload arrives while B is still in flight. If A's `finally` wrongly
    // nulled the shared handle, this incorrectly thinks nothing is in flight and
    // starts a 3rd fetch instead of coalescing onto B.
    void useDashboardStore.getState().loadSummaries(true)

    expect(apiListDashboards).toHaveBeenCalledTimes(2)

    resolveB([])
    await loadB
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

  it('suppresses all reloads for a local share role-change echo (share_updated)', async () => {
    recordPendingDashboardMutation('share-mut-2')

    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        event_type: 'dashboard.share_updated',
        entity_version: 2,
        payload: {
          dashboard_id: 'dash-1',
          client_mutation_id: 'share-mut-2',
        },
      }),
    )

    // A role change alters nothing this client caches — no summaries or dashboard refetch.
    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetDashboard).not.toHaveBeenCalled()
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

  it('coalesces rapid layout saves and re-reads the bumped version', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const layoutA = [{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }]
    const layoutB = [{ i: 'w1', x: 2, y: 0, w: 4, h: 3 }]
    const layoutC = [{ i: 'w1', x: 3, y: 0, w: 4, h: 3 }]

    const savePromise = useDashboardStore.getState().saveLayout(layoutA)
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(1, 'dash-1', layoutA, 1, expect.anything())

    // B then C arrive while A is still in flight: only the latest survives.
    void useDashboardStore.getState().saveLayout(layoutB)
    void useDashboardStore.getState().saveLayout(layoutC)
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1)

    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2, layout: layoutA }) })
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(2))
    // The follow-up PUT carries the bumped version and the coalesced latest layout (B dropped).
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(2, 'dash-1', layoutC, 2, expect.anything())

    resolvers[1]({ conflict: false, dashboard: makeDashboard({ version: 3, layout: layoutC }) })
    await savePromise
    expect(useDashboardStore.getState().conflict).toBe(false)
    expect(useDashboardStore.getState().dashboard?.version).toBe(3)
  })

  it('rebases onto the other editor and retries once, without a banner', async () => {
    apiUpdateLayout
      .mockResolvedValueOnce({ conflict: true })
      .mockResolvedValueOnce({ conflict: false, dashboard: makeDashboard({ version: 6 }) })
    // The other editor bumped the version and added a widget this client has never seen.
    apiGetDashboard.mockResolvedValue(
      makeDashboard({
        version: 5,
        layout: [
          { i: 'w1', x: 0, y: 0, w: 4, h: 3 },
          { i: 'w2', x: 4, y: 0, w: 4, h: 3 },
        ],
      }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    await useDashboardStore.getState().saveLayout([{ i: 'w1', x: 6, y: 2, w: 4, h: 3 }])

    // Asserting the call, not the resulting layout: a user who hit reload would also end up
    // correct, so only the retry itself distinguishes this from the old banner.
    expect(apiUpdateLayout).toHaveBeenCalledTimes(2)
    const [, retriedLayout, retriedVersion] = apiUpdateLayout.mock.calls[1]
    expect(retriedVersion).toBe(5)
    expect(retriedLayout).toContainEqual({ i: 'w1', x: 6, y: 2, w: 4, h: 3 })
    // Posting our own array wholesale would have stripped w2 — PUT /layout replaces the blob.
    expect(retriedLayout).toContainEqual({ i: 'w2', x: 4, y: 0, w: 4, h: 3 })
    expect(useDashboardStore.getState().conflict).toBe(false)
  })

  it('shows the banner only once the retry is beaten too', async () => {
    apiUpdateLayout.mockResolvedValue({ conflict: true })
    apiGetDashboard.mockResolvedValue(makeDashboard({ version: 5 }))
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    await useDashboardStore.getState().saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])

    expect(apiUpdateLayout).toHaveBeenCalledTimes(2)
    expect(useDashboardStore.getState().conflict).toBe(true)
    // The rebase still leaves the client on the server's version, so the reload the banner offers
    // is about the layout it lost, not about being stuck one version behind forever.
    expect(useDashboardStore.getState().dashboard?.version).toBe(5)
  })

  it('falls back to the banner when the rebase read fails', async () => {
    apiUpdateLayout.mockResolvedValue({ conflict: true })
    apiGetDashboard.mockRejectedValue(new Error('offline'))
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    await useDashboardStore.getState().saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])

    // No blind retry: without the server's version the retry would 409 again by construction.
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().conflict).toBe(true)
  })

  it('drops the layout save when the session resets mid-flight', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const savePromise = useDashboardStore
      .getState()
      .saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))

    resetDashboardData() // account boundary: bumps sessionGeneration and clears save state
    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2 }) })
    await savePromise

    expect(useDashboardStore.getState().dashboard).toBeNull()
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1)
  })

  it('createDashboard resolves null on API failure instead of throwing', async () => {
    apiCreateDashboard.mockRejectedValue(new Error('boom'))
    useDashboardStore.setState({ summaries: [] })

    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Failed to create dashboard.')
  })

  it('createDashboard resolves the summary on success', async () => {
    const summary = makeSummary({ id: 'dash-new', name: 'X' })
    apiCreateDashboard.mockResolvedValue(summary)
    useDashboardStore.setState({ summaries: [] })

    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toEqual(
      summary,
    )
  })

  it('renameDashboard resolves false on failure and true on success', async () => {
    useDashboardStore.setState({ summaries: [makeSummary()], dashboard: makeDashboard() })

    apiUpdateDashboardMeta.mockRejectedValueOnce(new Error('boom'))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith('Failed to rename dashboard.')

    apiUpdateDashboardMeta.mockResolvedValueOnce(makeDashboard({ name: 'New' }))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(true)
  })

  it('addWidget resolves false on failure and true on success', async () => {
    useDashboardStore.setState({ dashboard: makeDashboard() })

    apiAddWidget.mockRejectedValueOnce(new Error('boom'))
    await expect(useDashboardStore.getState().addWidget({ widget_type: 'clock' })).resolves.toBe(
      false,
    )

    apiAddWidget.mockResolvedValueOnce(makeDashboard({ version: 2 }))
    await expect(useDashboardStore.getState().addWidget({ widget_type: 'clock' })).resolves.toBe(
      true,
    )
  })

  it('does not start a concurrent drain when a superseded save resolves after a session reset', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    // Old session: a drain is in flight, awaiting its PUT.
    const oldSave = useDashboardStore.getState().saveLayout([{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }])
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))

    // Auth boundary: bumps the generation and clears the drain flag/state.
    resetDashboardData()

    // New session loads a dashboard and starts its own drain.
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })
    void useDashboardStore.getState().saveLayout([{ i: 'w1', x: 2, y: 0, w: 4, h: 3 }])
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(2))

    // The old (superseded) PUT resolves — its drain must not release the new drain's flag.
    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2 }) })
    await oldSave

    // A subsequent save must coalesce into the still-running new drain, not spawn a concurrent one.
    void useDashboardStore.getState().saveLayout([{ i: 'w1', x: 3, y: 0, w: 4, h: 3 }])
    await Promise.resolve()
    expect(apiUpdateLayout).toHaveBeenCalledTimes(2)
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
      widget_type: 'calendar' as const,
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
      useDashboardStore.getState().handleDashboardEvent(RESYNC_SIGNAL),
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

  it('settles a pending debounced summaries-refresh promise on reset instead of hanging', async () => {
    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: null,
    })

    // Not awaited yet: handleDashboardEvent runs synchronously up to `await
    // summariesRefreshPromise`, which is the debounce promise from
    // scheduleSummariesRefresh — so by the time this call returns, the pending
    // debounce promise already exists in module state.
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

  it('loadTrash single-flights concurrent calls and caches the result', async () => {
    apiGetTrash.mockResolvedValue([makeTrashed()])

    // StrictMode's double-mounted effect collapses to one request…
    await Promise.all([
      useDashboardStore.getState().loadTrash(),
      useDashboardStore.getState().loadTrash(),
    ])
    expect(apiGetTrash).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().trash).toHaveLength(1)

    // …a revisit costs nothing…
    await useDashboardStore.getState().loadTrash()
    expect(apiGetTrash).toHaveBeenCalledTimes(1)

    // …and only an explicit force refetches.
    await useDashboardStore.getState().loadTrash(true)
    expect(apiGetTrash).toHaveBeenCalledTimes(2)
  })

  it('a failed trash load stays un-cached so the next visit retries', async () => {
    apiGetTrash.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([makeTrashed()])

    await useDashboardStore.getState().loadTrash()
    expect(useDashboardStore.getState().trashLoaded).toBe(false)

    await useDashboardStore.getState().loadTrash()
    expect(useDashboardStore.getState().trash).toHaveLength(1)
    expect(useDashboardStore.getState().trashLoaded).toBe(true)
  })

  it('deleteDashboard refreshes an already-loaded trash cache', async () => {
    apiDeleteDashboard.mockResolvedValue(undefined)
    apiGetTrash.mockResolvedValue([makeTrashed({ id: 'dash-1' })])
    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      trash: [],
      trashLoaded: true,
    })

    expect(await useDashboardStore.getState().deleteDashboard('dash-1')).toBe(true)
    expect(useDashboardStore.getState().summaries).toHaveLength(0)
    await vi.waitFor(() => expect(useDashboardStore.getState().trash).toHaveLength(1))
  })

  it('restoreDashboard updates both caches locally and suppresses its SSE echo', async () => {
    apiRestoreDashboard.mockResolvedValue(makeSummary({ id: 'dash-9', name: 'Old Dashboard' }))
    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: true,
      trash: [makeTrashed({ id: 'dash-9' })],
      trashLoaded: true,
    })

    expect(await useDashboardStore.getState().restoreDashboard('dash-9')).toMatchObject({
      id: 'dash-9',
    })
    expect(useDashboardStore.getState().trash).toHaveLength(0)
    expect(useDashboardStore.getState().summaries[0]?.id).toBe('dash-9')

    const clientMutationId = (
      apiRestoreDashboard.mock.calls[0]?.[1] as { clientMutationId?: string } | undefined
    )?.clientMutationId
    expect(clientMutationId).toBeTruthy()

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_id: 'dash-9',
        payload: {
          dashboard_id: 'dash-9',
          changed_fields: ['restored'],
          client_mutation_id: clientMutationId,
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetTrash).not.toHaveBeenCalled()
  })

  it('reloads the trash cache for a restore done in another session', async () => {
    apiGetTrash.mockResolvedValue([])
    apiListDashboards.mockResolvedValue([makeSummary()])
    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      trash: [makeTrashed({ id: 'dash-1' })],
      trashLoaded: true,
    })

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        actor_id: 'user-2',
        payload: { dashboard_id: 'dash-1', changed_fields: ['restored'] },
      }),
    )

    await vi.waitFor(() => expect(apiGetTrash).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(useDashboardStore.getState().trash).toHaveLength(0))
  })

  it('resetDashboardData clears store fields and the pending-mutation map', () => {
    useDashboardStore.setState({
      summaries: [makeSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
      loadError: true,
      conflict: true,
    })
    recordPendingDashboardMutation('m-1')

    resetDashboardData()

    const s = useDashboardStore.getState()
    expect(s.summaries).toEqual([])
    expect(s.summariesLoaded).toBe(false)
    expect(s.dashboard).toBeNull()
    expect(s.loadError).toBe(false)
    expect(s.conflict).toBe(false)
    // The stale account's pending-mutation id no longer suppresses an echo.
    expect(consumePendingDashboardMutation('m-1')).toBe(false)
  })

  it('drops a summaries load that resolves after a reset', async () => {
    let resolveList!: (v: DashboardSummary[]) => void
    apiListDashboards.mockReturnValue(
      new Promise((r) => {
        resolveList = r
      }),
    )

    const loading = useDashboardStore.getState().loadSummaries()
    resetDashboardData() // account boundary while the fetch is in flight

    resolveList([makeSummary()])
    await loading

    // The stale account's summaries must not land in the new session's store.
    expect(useDashboardStore.getState().summaries).toEqual([])
    expect(useDashboardStore.getState().summariesLoaded).toBe(false)
  })

  it('a fresh loadSummaries refetches after a reset (no stale summariesLoaded)', async () => {
    apiListDashboards.mockResolvedValue([makeSummary({ id: 'a' })])
    await useDashboardStore.getState().loadSummaries()
    expect(useDashboardStore.getState().summariesLoaded).toBe(true)

    resetDashboardData() // account boundary

    apiListDashboards.mockResolvedValue([makeSummary({ id: 'b' })])
    await useDashboardStore.getState().loadSummaries()
    // Without the reset, summariesLoaded would short-circuit the second load and
    // the new account would see account A's card.
    expect(useDashboardStore.getState().summaries.map((d) => d.id)).toEqual(['b'])
  })

  it('drops a dashboard creation that resolves after a reset', async () => {
    let resolveCreate!: (v: DashboardSummary) => void
    apiCreateDashboard.mockReturnValue(
      new Promise((r) => {
        resolveCreate = r
      }),
    )

    const creating = useDashboardStore.getState().createDashboard({ name: 'New Dashboard' })
    resetDashboardData()

    resolveCreate(makeSummary({ id: 'new-1', name: 'New Dashboard' }))
    await creating.catch(() => {})

    // The prepend write is a literal value, not a merge over current state, so a stale
    // create landing after the boundary would be visible as a non-empty array.
    expect(useDashboardStore.getState().summaries).toEqual([])
  })

  it("does not leave loading stuck true when a reset lands between a queued dashboard load's loop iterations", async () => {
    let resolveFirstRequest!: (value: Dashboard) => void

    apiGetDashboard
      .mockImplementationOnce(
        () =>
          new Promise<Dashboard>((resolve) => {
            resolveFirstRequest = resolve
          }),
      )
      .mockResolvedValueOnce(makeDashboard({ name: 'Also Stale' }))

    useDashboardStore.setState({
      dashboard: makeDashboard(),
      loading: false,
      loadError: false,
    })

    // Background load starts first (showLoading = false for its own iteration)...
    const initialLoad = useDashboardStore.getState().loadDashboard('dash-1', {
      background: true,
    })
    // ...then a foreground request queues a follow-up iteration behind it.
    const followUpLoad = useDashboardStore.getState().loadDashboard('dash-1', {})

    resetDashboardData() // account boundary while the first fetch is still in flight

    resolveFirstRequest(makeDashboard({ name: 'Stale Dashboard' }))
    await Promise.all([initialLoad, followUpLoad])

    // The queued (2nd) loop iteration's `loading: true` write must be dropped by the
    // guard just like every other post-boundary write — it must not get stuck true.
    expect(useDashboardStore.getState().loading).toBe(false)
    expect(useDashboardStore.getState().dashboard).toBeNull()
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
            widget_version: 1,
            config: { view: 'month' },
            resource_type: null,
            resource_id: null,
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
            widget_version: 1,
            config: { view: 'month' },
            resource_type: null,
            resource_id: null,
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
