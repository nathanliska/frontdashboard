// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeListDetail, makeListItem } from '../test/fixtures'
import { capturedOnReorder } from '../test/sortable-list'
import { ListDetailPage } from './ListDetailPage'

const { reorderListItems, mockedUseListDetail, sortableListSpy, refetch, toastError } = vi.hoisted(
  () => ({
    reorderListItems: vi.fn(),
    mockedUseListDetail: vi.fn(),
    sortableListSpy: vi.fn(),
    refetch: vi.fn(),
    toastError: vi.fn(),
  }),
)

vi.mock('../stores/toast', async () =>
  (await import('../test/toast')).toastMock({ error: toastError }),
)

vi.mock('../resources/listData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/listData')>()),
  reorderListItems,
  useListDetail: () => mockedUseListDetail(),
}))

vi.mock('../components/lists/SortableList', async () => {
  const { sortableListMock } = await import('../test/sortable-list')
  return sortableListMock(sortableListSpy)
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/lists/list-1']}>
      <Routes>
        <Route path="/lists/:listId" element={<ListDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ListDetailPage item reordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubDashboardStore()
  })

  // Reordering is offered only when it can actually do something: an editable list with enough
  // items to have an order worth changing.
  it.each([
    { name: 'an editable list with three items', detail: {}, handles: 3, disabled: false },
    { name: 'a single-item list', detail: { itemIds: ['a'] }, handles: 0, disabled: true },
  ])('renders $handles drag handles for $name', ({ detail, handles, disabled }) => {
    mockedUseListDetail.mockReturnValue({
      data: makeListDetail({ itemIds: ['a', 'b', 'c'], ...detail }),
      error: null,
    })

    renderPage()

    expect(screen.queryAllByLabelText('Reorder item')).toHaveLength(handles)
    expect(sortableListSpy).toHaveBeenCalledWith(disabled, expect.any(Function))
  })

  it('wires the SortableList onReorder callback to reorderListItems(listId, orderedIds)', () => {
    mockedUseListDetail.mockReturnValue({
      data: makeListDetail({ itemIds: ['a', 'b', 'c'] }),
      error: null,
    })
    renderPage()

    capturedOnReorder(sortableListSpy)(['b', 'a', 'c'])

    expect(reorderListItems).toHaveBeenCalledWith('list-1', ['b', 'a', 'c'])
  })

  describe('with the checked pile on', () => {
    function withPile() {
      mockedUseListDetail.mockReturnValue({
        data: makeListDetail({
          items: [
            makeListItem({ id: 'bread', sort_order: 0 }),
            makeListItem({ id: 'milk', sort_order: 1, checked: true }),
            makeListItem({ id: 'eggs', sort_order: 2 }),
            makeListItem({ id: 'rice', sort_order: 3 }),
          ],
        }),
        error: null,
        refetch,
      })
      renderPage()
    }

    it('submits the full set, holding checked items at their stored positions', () => {
      withPile()
      capturedOnReorder(sortableListSpy)(['rice', 'bread', 'eggs'])
      expect(reorderListItems).toHaveBeenCalledWith('list-1', ['rice', 'milk', 'bread', 'eggs'])
    })

    it('resyncs instead of submitting when the list changed under the drag', () => {
      withPile()
      // "milk" was active when the drag started and is checked by the time it drops, so the
      // merge cannot place it. The nearest valid set is the stored order — a 204 that would
      // throw the drop away without saying so.
      capturedOnReorder(sortableListSpy)(['rice', 'milk', 'bread', 'eggs'])
      expect(reorderListItems).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith('Could not save order — refreshed.')
      expect(refetch).toHaveBeenCalled()
    })
  })
})
