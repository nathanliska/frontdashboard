import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrashedDashboard } from '../../api/dashboards'
import { beginDashboardStoreTest } from '../../test/dashboard-store'
import {
  apiDeleteDashboard,
  apiGetTrash,
  apiListDashboards,
  apiPurgeDashboard,
  apiRestoreDashboard,
} from '../../test/dashboard-store-mocks'
import { makeDashboardSummary, makeSseEvent } from '../../test/fixtures'
import { CLIENT_INSTANCE_ID } from '../../utils/shared/clientInstance'
import { useDashboardStore } from '../dashboard'

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

function makeTrashed(overrides: Partial<TrashedDashboard> = {}): TrashedDashboard {
  return {
    id: 'dash-9',
    name: 'Old Dashboard',
    deleted_at: '2026-04-05T00:00:00Z',
    purge_at: '2026-05-05T00:00:00Z',
    ...overrides,
  }
}

describe('useDashboardStore trash', () => {
  beforeEach(beginDashboardStoreTest)

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
      summaries: [makeDashboardSummary()],
      summariesLoaded: true,
      trash: [],
      trashLoaded: true,
    })

    expect(await useDashboardStore.getState().deleteDashboard('dash-1')).toBe(true)
    expect(useDashboardStore.getState().summaries).toHaveLength(0)
    await vi.waitFor(() => expect(useDashboardStore.getState().trash).toHaveLength(1))
  })

  it('purgeDashboard drops the row from the trash cache without refetching', async () => {
    apiPurgeDashboard.mockResolvedValue(undefined)
    useDashboardStore.setState({
      summaries: [],
      summariesLoaded: true,
      trash: [makeTrashed({ id: 'dash-9' }), makeTrashed({ id: 'dash-7' })],
      trashLoaded: true,
    })

    expect(await useDashboardStore.getState().purgeDashboard('dash-9')).toBe(true)
    expect(useDashboardStore.getState().trash.map((t) => t.id)).toEqual(['dash-7'])
    // A 204 carries no body and nothing else holds the row, so a reload would be the bug.
    expect(apiGetTrash).not.toHaveBeenCalled()
  })

  it('restoreDashboard updates both caches locally and suppresses its SSE echo', async () => {
    apiRestoreDashboard.mockResolvedValue(
      makeDashboardSummary({ id: 'dash-9', name: 'Old Dashboard' }),
    )
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

    await useDashboardStore.getState().handleDashboardEvent(
      makeSseEvent({
        entity_id: 'dash-9',
        payload: {
          dashboard_id: 'dash-9',
          changed_fields: ['restored'],
          origin_client_id: CLIENT_INSTANCE_ID,
        },
      }),
    )

    expect(apiListDashboards).not.toHaveBeenCalled()
    expect(apiGetTrash).not.toHaveBeenCalled()
  })

  it('reloads the trash cache for a restore done in another session', async () => {
    apiGetTrash.mockResolvedValue([])
    apiListDashboards.mockResolvedValue([makeDashboardSummary()])
    useDashboardStore.setState({
      summaries: [makeDashboardSummary()],
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
})
