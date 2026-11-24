// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListSummary } from '../api/lists'
import { deferred, makeListItem, makeListSummary } from '../test/fixtures'
import { signIn } from '../test/signIn'
import { resetAgendaData, useAgendaItems } from './agendaData'
import { fetchDashboardLists } from './dashboardListsBatch'
import * as lists from './listData'

const api = vi.hoisted(() => ({
  apiCreateItem: vi.fn(),
  apiCreateList: vi.fn(),
  apiDeleteItem: vi.fn(),
  apiDeleteList: vi.fn(),
  apiGetList: vi.fn(),
  apiGetListDetails: vi.fn(),
  apiGetLists: vi.fn(),
  apiReorderItems: vi.fn(),
  apiReorderLists: vi.fn(),
  apiRestoreList: vi.fn(),
  apiUpdateItem: vi.fn(),
  apiUpdateList: vi.fn(),
}))

vi.mock('../api/lists', () => api)
vi.mock('../stores/toast', async () => (await import('../test/toast')).toastMock())
vi.mock('./occurrenceStore', () => ({
  useOccurrences: () => ({ data: [], loaded: true, loading: false, error: null, refetch() {} }),
  resetOccurrences() {},
}))

const before = makeListSummary({ id: 'list-1', dashboard_id: 'dash-1', name: 'Before' })
const after = { ...before, name: 'After' }
const item = makeListItem({ id: 'item-1', list_id: 'list-1' })

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  lists.__resetListDataForTests()
  resetAgendaData()
  signIn()
  api.apiCreateList.mockResolvedValue(before)
  api.apiRestoreList.mockResolvedValue(before)
  api.apiUpdateList.mockResolvedValue(after)
  api.apiCreateItem.mockResolvedValue(item)
  api.apiUpdateItem.mockResolvedValue(item)
})

describe('our own list writes', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['create', () => lists.createList('Before', 'todo', 'dash-1')],
    ['rename', () => lists.updateListName('list-1', 'After')],
    ['delete', () => lists.deleteList('list-1', 'dash-1')],
    ['restore', () => lists.restoreList('list-1', 'dash-1')],
    ['item add', () => lists.addListItem('list-1', 'Milk')],
    ['item update', () => lists.updateListItem('list-1', 'item-1', { checked: true })],
    ['item delete', () => lists.deleteListItem('list-1', 'item-1')],
    ['item reorder', () => lists.reorderListItems('list-1', ['item-1'])],
    ['list reorder', () => lists.reorderLists('dash-1', ['list-1'])],
  ])('mark a batch still out as old after a %s, without another request', async (_, write) => {
    const batch = deferred<ListDetail[]>()
    api.apiGetListDetails.mockReturnValueOnce(batch.promise)
    const read = fetchDashboardLists('dash-1')

    await write()
    batch.resolve([])

    expect((await read).overtaken).toBe(true)
    expect(api.apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('keep a rename that lands while the batch loads the lists', async () => {
    const batch = deferred<ListDetail[]>()
    api.apiGetListDetails
      .mockReturnValueOnce(batch.promise)
      .mockResolvedValueOnce([{ ...after, items: [] }])
    const { result } = renderHook(() => lists.useListSummaries('dash-1', { withItems: true }))

    await act(() => lists.updateListName('list-1', 'After'))
    await act(async () => batch.resolve([{ ...before, items: [] }]))

    await vi.waitFor(() => expect(result.current.data?.[0]?.name).toBe('After'))
    expect(api.apiGetListDetails).toHaveBeenCalledTimes(2)
  })

  it('never show the answer a write overtook', async () => {
    const older = deferred<ListSummary[]>()
    const newer = deferred<ListSummary[]>()
    api.apiGetLists.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result } = renderHook(() => lists.useListSummaries('dash-1'))

    await act(() => lists.deleteList('list-1', 'dash-1'))
    await act(async () => older.resolve([before]))

    expect(result.current.data).toBeNull()
    await act(async () => newer.resolve([]))
    expect(result.current.data).toEqual([])
  })

  it('leave an agenda load alone when checking an item that has no due date', async () => {
    const batch = deferred<ListDetail[]>()
    const undated = { ...item, due_date: null }
    lists.__seedListDetailForTests('list-1', { ...before, items: [undated] })
    api.apiUpdateItem.mockResolvedValue({ ...undated, checked: true })
    api.apiGetListDetails.mockReturnValueOnce(batch.promise).mockResolvedValue([])
    const { result } = renderHook(() => useAgendaItems('dash-1'))

    await act(() => lists.updateListItem('list-1', 'item-1', { checked: true }))
    await act(async () => batch.resolve([]))

    await vi.waitFor(() => expect(result.current.data).toEqual([]))
    expect(api.apiGetListDetails).toHaveBeenCalledTimes(1)
  })

  it('take an item off the agenda when its due date is cleared', async () => {
    const dated = { ...item, due_date: '2026-01-05' }
    lists.__seedListDetailForTests('list-1', { ...before, items: [dated] })
    api.apiUpdateItem.mockResolvedValue({ ...dated, due_date: null })
    api.apiGetListDetails.mockResolvedValue([{ ...before, items: [dated] }])
    const { result } = renderHook(() => useAgendaItems('dash-1'))
    await vi.waitFor(() => expect(result.current.data).toHaveLength(1))

    await act(() => lists.updateListItem('list-1', 'item-1', { due_date: null }))

    expect(result.current.data).toEqual([])
  })

  it("leave another dashboard's agenda load alone on a delete", async () => {
    const batch = deferred<ListDetail[]>()
    api.apiGetListDetails.mockReturnValueOnce(batch.promise).mockResolvedValue([])
    const { result } = renderHook(() => useAgendaItems('dash-2'))

    await act(() => lists.deleteList('list-1', 'dash-1'))
    await act(async () => batch.resolve([]))

    await vi.waitFor(() => expect(result.current.data).toEqual([]))
    expect(api.apiGetListDetails).toHaveBeenCalledTimes(1)
  })
})
