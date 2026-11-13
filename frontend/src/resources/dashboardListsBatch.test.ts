import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail } from '../api/lists'
import {
  fetchDashboardLists,
  markDashboardListsChanged,
  resetDashboardListsBatch,
} from './dashboardListsBatch'

const { apiGetListDetails } = vi.hoisted(() => ({ apiGetListDetails: vi.fn() }))
vi.mock('../api/lists', () => ({ apiGetListDetails }))

const answer = (name: string) => [{ id: 'list-1', name }] as unknown as ListDetail[]

/** Queue one unsettled response per call, and hand back the means to settle them in order. */
function deferResponses() {
  const pending: Array<(lists: ListDetail[]) => void> = []
  apiGetListDetails.mockImplementation(
    () => new Promise<ListDetail[]>((resolve) => pending.push(resolve)),
  )
  return (name: string) => pending.shift()?.(answer(name))
}

describe('the dashboard list batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDashboardListsBatch()
  })

  it('shares one request between callers that ask while it is out, then asks again', async () => {
    const settle = deferResponses()

    const both = Promise.all([fetchDashboardLists('dash-1'), fetchDashboardLists('dash-1')])
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
    settle('v1')
    await both

    void fetchDashboardLists('dash-1')
    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('gives a caller that asks after a change an answer read after it', async () => {
    const settle = deferResponses()

    const before = fetchDashboardLists('dash-1')
    markDashboardListsChanged()
    const after = fetchDashboardLists('dash-1')
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)

    settle('from before the change')
    await vi.waitFor(() => expect(apiGetListDetails).toHaveBeenCalledTimes(2))
    settle('from after it')

    const current = { lists: answer('from after it'), overtaken: false }
    await expect(after).resolves.toEqual(current)
    await expect(before).resolves.toEqual(current)
  })

  it('says a batch is old when a change landed while it was out and nobody asked again', async () => {
    const settle = deferResponses()

    const read = fetchDashboardLists('dash-1')
    markDashboardListsChanged()
    settle('from before the change')

    await expect(read).resolves.toMatchObject({ overtaken: true })
    expect(apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('never hands a request opened before a reset to a caller after it', () => {
    deferResponses()

    void fetchDashboardLists('dash-1')
    resetDashboardListsBatch()
    void fetchDashboardLists('dash-1')

    expect(apiGetListDetails).toHaveBeenCalledTimes(2)
  })
})
