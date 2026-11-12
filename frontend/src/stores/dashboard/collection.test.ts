import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSummary } from '../../api/dashboards'
import { beginDashboardStoreTest } from '../../test/dashboard-store'
import {
  apiCreateDashboard,
  apiGetDashboard,
  apiListDashboards,
  apiTransferDashboardOwnership,
  apiUpdateDashboardMeta,
  apiUpdatePreferences,
  toastError,
} from '../../test/dashboard-store-mocks'
import { makeDashboard, makeDashboardSummary } from '../../test/fixtures'
import { useAuthStore } from '../auth'
import { useConnectionStore } from '../connection'
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

describe('useDashboardStore collection', () => {
  beforeEach(beginDashboardStoreTest)

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
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
    })

    await useDashboardStore.getState().toggleFavorite('dash-1', false)

    expect(apiUpdatePreferences).toHaveBeenCalledWith({ favorite_dashboard_ids: ['dash-1'] })
    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.preferences?.favorite_dashboard_ids).toEqual(['dash-1'])
    expect(useDashboardStore.getState().dashboard?.is_favorite).toBe(true)
    expect(useDashboardStore.getState().summaries).toEqual([
      makeDashboardSummary({ is_favorite: true }),
    ])
  })

  it('queues a forced summaries reload when a previous summaries request is already in flight', async () => {
    let resolveFirstRequest!: (value: DashboardSummary[]) => void
    const refreshedSummaries = [makeDashboardSummary({ id: 'dash-2', name: 'Shared Later' })]

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

  it('createDashboard resolves null on API failure instead of throwing', async () => {
    apiCreateDashboard.mockRejectedValue(new Error('boom'))
    useDashboardStore.setState({ summaries: [] })

    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toBeNull()
    expect(toastError).toHaveBeenCalledWith('Failed to create dashboard.')
  })

  it('createDashboard resolves the summary on success', async () => {
    const summary = makeDashboardSummary({ id: 'dash-new', name: 'X' })
    apiCreateDashboard.mockResolvedValue(summary)
    useDashboardStore.setState({ summaries: [] })

    await expect(useDashboardStore.getState().createDashboard({ name: 'X' })).resolves.toEqual(
      summary,
    )
  })

  it('opens a dashboard this client just created without reading it back', async () => {
    useConnectionStore.setState({ status: 'connected' })
    const summary = makeDashboardSummary({ id: 'dash-new', name: 'X' })
    // A layout the client could not have built itself, so only the response can be its source.
    const board = makeDashboard({
      id: 'dash-new',
      name: 'X',
      layout: [{ i: 'w1', x: 0, y: 0, w: 4, h: 4 }],
    })
    apiCreateDashboard.mockResolvedValue({
      ...summary,
      layout: board.layout,
      widgets: board.widgets,
    })
    useDashboardStore.setState({ summaries: [] })

    await useDashboardStore.getState().createDashboard({ name: 'X' })
    await useDashboardStore.getState().loadDashboard('dash-new')

    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard).toMatchObject({
      id: 'dash-new',
      layout: board.layout,
      widgets: board.widgets,
    })
    expect(useDashboardStore.getState().summaries).toEqual([summary])
  })

  it('renameDashboard resolves false on failure and true on success', async () => {
    useDashboardStore.setState({ summaries: [makeDashboardSummary()], dashboard: makeDashboard() })

    apiUpdateDashboardMeta.mockRejectedValueOnce(new Error('boom'))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(false)
    expect(toastError).toHaveBeenCalledWith('Failed to rename dashboard.')

    apiUpdateDashboardMeta.mockResolvedValueOnce(makeDashboard({ name: 'New' }))
    await expect(useDashboardStore.getState().renameDashboard('dash-1', 'New')).resolves.toBe(true)
  })

  it('transferDashboard hands the held dashboard over and drops share management', async () => {
    useDashboardStore.setState({ dashboard: makeDashboard(), summaries: [makeDashboardSummary()] })

    apiTransferDashboardOwnership.mockRejectedValueOnce(new Error('boom'))
    await expect(useDashboardStore.getState().transferDashboard('dash-1', 'user-2')).resolves.toBe(
      false,
    )
    expect(toastError).toHaveBeenCalledWith('Failed to transfer ownership.')

    apiTransferDashboardOwnership.mockResolvedValueOnce(
      makeDashboardSummary({ user_id: 'user-2', can_edit: true, can_manage_shares: false }),
    )
    await expect(useDashboardStore.getState().transferDashboard('dash-1', 'user-2')).resolves.toBe(
      true,
    )
    expect(useDashboardStore.getState().dashboard).toMatchObject({
      user_id: 'user-2',
      can_edit: true,
      can_manage_shares: false,
    })
    expect(useDashboardStore.getState().summaries[0]).toMatchObject({ user_id: 'user-2' })
  })

  it('resetDashboardData clears store fields', () => {
    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      dashboard: makeDashboard(),
      loadError: true,
      conflict: true,
    })

    resetDashboardData()

    const s = useDashboardStore.getState()
    expect(s.summaries).toEqual([])
    expect(s.summariesLoaded).toBe(false)
    expect(s.dashboard).toBeNull()
    expect(s.loadError).toBe(false)
    expect(s.conflict).toBe(false)
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

    resolveList([makeDashboardSummary()])
    await loading

    // The stale account's summaries must not land in the new session's store.
    expect(useDashboardStore.getState().summaries).toEqual([])
    expect(useDashboardStore.getState().summariesLoaded).toBe(false)
  })

  it('a fresh loadSummaries refetches after a reset (no stale summariesLoaded)', async () => {
    apiListDashboards.mockResolvedValue([makeDashboardSummary({ id: 'a' })])
    await useDashboardStore.getState().loadSummaries()
    expect(useDashboardStore.getState().summariesLoaded).toBe(true)

    resetDashboardData() // account boundary

    apiListDashboards.mockResolvedValue([makeDashboardSummary({ id: 'b' })])
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

    resolveCreate(makeDashboardSummary({ id: 'new-1', name: 'New Dashboard' }))
    await creating.catch(() => {})

    // The prepend write is a literal value, not a merge over current state, so a stale
    // create landing after the boundary would be visible as a non-empty array.
    expect(useDashboardStore.getState().summaries).toEqual([])
  })
})
