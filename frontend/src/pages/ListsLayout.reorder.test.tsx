// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboardSummary, makeListSummary } from '../test/fixtures'
import { capturedOnReorder } from '../test/sortable-list'
import { ListsLayout } from './ListsLayout'

const { reorderLists, mockedUseListSummaries, sortableListSpy } = vi.hoisted(() => ({
  reorderLists: vi.fn(),
  mockedUseListSummaries: vi.fn(),
  sortableListSpy: vi.fn(),
}))

vi.mock('../resources/listData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/listData')>()),
  reorderLists,
  useListSummaries: () => mockedUseListSummaries(),
}))

vi.mock('../api/lists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/lists')>()),
  apiGetListTrash: () => Promise.resolve([]),
}))

vi.mock('../components/lists/SortableList', async () => {
  const { sortableListMock } = await import('../test/sortable-list')
  return sortableListMock(sortableListSpy)
})

const ACTIVE_THREE = ['A', 'B', 'C'].map((name) =>
  makeListSummary({ id: name.toLowerCase(), name }),
)

function showLists(lists: ReturnType<typeof makeListSummary>[]) {
  mockedUseListSummaries.mockReturnValue({ data: lists, loading: false, error: null })
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/lists?dashboard_id=dash-1']}>
      <Routes>
        <Route path="/lists" element={<ListsLayout />}>
          <Route path=":listId" element={<div>detail</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ListsLayout list reordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubDashboardStore({ summaries: [makeDashboardSummary({ id: 'dash-1' })] })
  })

  // Dragging writes an absolute order, so it is only offered when the visible rows *are* the
  // full orderable set: the unfiltered active view, with at least two rows to swap.
  it.each([
    {
      view: 'the default Active view with three lists',
      lists: ACTIVE_THREE,
      filter: null,
      handles: 3,
    },
    {
      view: 'the Active view with four lists',
      lists: [...ACTIVE_THREE, makeListSummary({ id: 'd', name: 'D' })],
      filter: null,
      handles: 4,
      present: ['D'],
    },
    {
      view: 'a type-filtered view',
      lists: [
        makeListSummary({ id: 'a', name: 'A', list_type: 'todo' }),
        makeListSummary({ id: 'b', name: 'B', list_type: 'todo' }),
        makeListSummary({ id: 'c', name: 'C', list_type: 'grocery' }),
      ],
      filter: 'Todo',
      handles: 0,
    },
    {
      view: 'a single-list dashboard',
      lists: [makeListSummary({ id: 'a', name: 'A' })],
      filter: null,
      handles: 0,
    },
  ])('renders $handles drag handles in $view', ({ lists, filter, handles, present }) => {
    showLists(lists)
    renderLayout()
    if (filter) fireEvent.click(screen.getByRole('button', { name: filter }))

    expect(screen.queryAllByLabelText('Reorder list')).toHaveLength(handles)
    expect(sortableListSpy).toHaveBeenCalledWith(handles === 0, expect.any(Function))
    for (const name of present ?? []) expect(screen.getByText(name)).toBeInTheDocument()
  })

  // The Trash view renders restore rows, not a sortable list — so there is no SortableList to
  // disable, and the active rows are gone entirely.
  it('renders neither drag handles nor a sortable list in the Trash view', async () => {
    showLists(ACTIVE_THREE)
    renderLayout()
    sortableListSpy.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Trash' }))

    expect(await screen.findByText('Nothing in the trash.')).toBeInTheDocument()
    expect(screen.queryAllByLabelText('Reorder list')).toHaveLength(0)
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(sortableListSpy).not.toHaveBeenCalled()
  })

  it('wires the SortableList onReorder callback to reorderLists(dashboardId, orderedIds)', () => {
    showLists(ACTIVE_THREE)
    renderLayout()

    capturedOnReorder(sortableListSpy)(['b', 'a', 'c'])

    expect(reorderLists).toHaveBeenCalledWith('dash-1', ['b', 'a', 'c'])
  })
})
