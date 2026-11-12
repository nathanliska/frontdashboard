import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dashboard } from '../../api/dashboards'
import { ApiError } from '../../api/http'
import { beginDashboardStoreTest } from '../../test/dashboard-store'
import {
  apiAddWidget,
  apiGetDashboard,
  apiRemoveWidget,
  apiUpdateLayout,
  applyCreatedList,
} from '../../test/dashboard-store-mocks'
import { makeDashboard, makeListSummary } from '../../test/fixtures'
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

describe('useDashboardStore active', () => {
  beforeEach(beginDashboardStoreTest)

  it('sends the gesture belonging to the layout that survived coalescing', async () => {
    const resolvers: ((v: { conflict: false; dashboard: Dashboard }) => void)[] = []
    apiUpdateLayout.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 1 }) })

    const layoutA = [{ i: 'w1', x: 1, y: 0, w: 4, h: 3 }]
    const layoutB = [{ i: 'w2', x: 2, y: 0, w: 4, h: 3 }]

    void useDashboardStore.getState().saveLayout(layoutA, { widget_id: 'w1', action: 'moved' })
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(1))

    // A second gesture lands mid-flight. Dropping the layout has to drop its gesture with it, or
    // the feed names the widget from a drag the server never saw.
    void useDashboardStore.getState().saveLayout(layoutB, { widget_id: 'w2', action: 'resized' })
    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2, layout: layoutA }) })

    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(2))
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(2, 'dash-1', layoutB, 2, {
      widget_id: 'w2',
      action: 'resized',
    })
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
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(1, 'dash-1', layoutA, 1, undefined)

    // B then C arrive while A is still in flight: only the latest survives.
    void useDashboardStore.getState().saveLayout(layoutB)
    void useDashboardStore.getState().saveLayout(layoutC)
    expect(apiUpdateLayout).toHaveBeenCalledTimes(1)

    resolvers[0]({ conflict: false, dashboard: makeDashboard({ version: 2, layout: layoutA }) })
    await vi.waitFor(() => expect(apiUpdateLayout).toHaveBeenCalledTimes(2))
    // The follow-up PUT carries the bumped version and the coalesced latest layout (B dropped).
    expect(apiUpdateLayout).toHaveBeenNthCalledWith(2, 'dash-1', layoutC, 2, undefined)

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

    await useDashboardStore
      .getState()
      .saveLayout([{ i: 'w1', x: 6, y: 2, w: 4, h: 3 }], { widget_id: 'w1', action: 'moved' })

    // Asserting the call, not the resulting layout: a user who hit reload would also end up
    // correct, so only the retry itself distinguishes this from the old banner.
    expect(apiUpdateLayout).toHaveBeenCalledTimes(2)
    const [, retriedLayout, retriedVersion, retriedGesture] = apiUpdateLayout.mock.calls[1]
    expect(retriedVersion).toBe(5)
    // The replay is the same drag rebased, so the feed must still name what was moved.
    expect(retriedGesture).toEqual({ widget_id: 'w1', action: 'moved' })
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

  it('removeWidget applies the board the server answers with', async () => {
    useDashboardStore.setState({ dashboard: makeDashboard({ version: 3 }) })
    // A version the client could not have guessed from its own copy.
    const answered = makeDashboard({ version: 9, widgets: [], layout: [] })
    apiRemoveWidget.mockResolvedValueOnce(answered)

    await expect(useDashboardStore.getState().removeWidget('w1')).resolves.toBe(true)

    expect(useDashboardStore.getState().dashboard).toEqual(answered)
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

  it('addWidget hands a list it created to the list caches, off the held dashboard', async () => {
    useDashboardStore.setState({ dashboard: makeDashboard() })
    const createdList = makeListSummary({ id: 'list-new' })
    apiAddWidget.mockResolvedValueOnce({
      ...makeDashboard({ version: 2 }),
      created_list: createdList,
    })

    await useDashboardStore.getState().addWidget({ widget_type: 'list', config: { name: 'New' } })

    expect(applyCreatedList).toHaveBeenCalledWith(createdList)
    expect(useDashboardStore.getState().dashboard).not.toHaveProperty('created_list')
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

  it('queues a follow-up background dashboard reload when a previous request is already in flight', async () => {
    let resolveFirstRequest!: (value: Dashboard) => void

    apiGetDashboard
      .mockImplementationOnce(
        () =>
          new Promise<Dashboard>((resolve) => {
            resolveFirstRequest = resolve
          }),
      )
      .mockRejectedValueOnce(new ApiError('Dashboard not found', 404))

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

  it('skips the network when re-opening the held dashboard with the stream connected', async () => {
    useConnectionStore.setState({ status: 'connected' })
    useDashboardStore.setState({ dashboard: makeDashboard() })

    await useDashboardStore.getState().loadDashboard('dash-1')

    expect(apiGetDashboard).not.toHaveBeenCalled()
    expect(useDashboardStore.getState().dashboard?.id).toBe('dash-1')
    expect(useDashboardStore.getState().loading).toBe(false)
  })

  it('refetches the held dashboard while the stream is degraded', async () => {
    useConnectionStore.setState({ status: 'reconnecting' })
    apiGetDashboard.mockResolvedValue(makeDashboard({ name: 'Fresh Dashboard' }))
    useDashboardStore.setState({ dashboard: makeDashboard() })

    await useDashboardStore.getState().loadDashboard('dash-1')

    expect(apiGetDashboard).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().dashboard?.name).toBe('Fresh Dashboard')
  })

  it('background loads of the held dashboard always fetch, even while connected', async () => {
    useConnectionStore.setState({ status: 'connected' })
    apiGetDashboard.mockResolvedValue(makeDashboard({ name: 'Fresh Dashboard' }))
    useDashboardStore.setState({ dashboard: makeDashboard() })

    await useDashboardStore.getState().loadDashboard('dash-1', { background: true })

    expect(apiGetDashboard).toHaveBeenCalledTimes(1)
    expect(useDashboardStore.getState().dashboard?.name).toBe('Fresh Dashboard')
  })

  it('a skipped re-open still invalidates an in-flight load for another dashboard', async () => {
    useConnectionStore.setState({ status: 'connected' })
    let resolveOther!: (value: Dashboard) => void
    apiGetDashboard.mockImplementation(
      () =>
        new Promise<Dashboard>((resolve) => {
          resolveOther = resolve
        }),
    )
    useDashboardStore.setState({ dashboard: makeDashboard() })

    const otherLoad = useDashboardStore.getState().loadDashboard('dash-2')
    await useDashboardStore.getState().loadDashboard('dash-1')

    resolveOther(makeDashboard({ id: 'dash-2' }))
    await otherLoad

    expect(useDashboardStore.getState().dashboard?.id).toBe('dash-1')
    expect(useDashboardStore.getState().loading).toBe(false)
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

    rejectFirstRequest(new ApiError('Dashboard not found', 404))
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
    // The rebase re-reads the dashboard before retrying; the retry then conflicts again.
    apiGetDashboard.mockResolvedValue(currentDashboard)

    useDashboardStore.setState({
      dashboard: currentDashboard,
      conflict: false,
    })

    await useDashboardStore.getState().saveLayout([])

    expect(apiUpdateLayout).toHaveBeenCalledWith('dash-1', [], 1, undefined)
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
