// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListSummary } from '../api/lists'
import { useDashboardStore } from '../stores/dashboard'
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

// Mirrors ListDetailPage.reorder.test.tsx's approach: replace SortableList/useSortableRow
// with a deterministic stand-in so we can assert (a) per-row handle presence, which is
// ListsLayout/ListSidebarRow's own logic, and (b) the exact onReorder wiring, without
// simulating a real dnd-kit drag in jsdom (flaky, per the task brief).
vi.mock('../components/lists/SortableList', () => ({
  SortableList: (props: {
    items: { id: string }[]
    onReorder: (orderedIds: string[]) => void
    children: (item: { id: string }) => React.ReactNode
    disabled?: boolean
  }) => {
    sortableListSpy(props.disabled, props.onReorder)
    return props.items.map((item) => props.children(item))
  },
  useSortableRow: (_id: string, disabled?: boolean) => ({
    setNodeRef: () => {},
    style: {},
    attributes: {},
    listeners: {},
    isDragging: false,
    disabled,
  }),
}))

function makeList(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'a',
    dashboard_id: 'd1',
    name: 'A',
    list_type: 'todo',
    sort_order: 0,
    archived: false,
    item_count: 0,
    created_by: 'u',
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/lists?dashboard_id=d1']}>
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
    useDashboardStore.setState({
      summaries: [
        {
          id: 'd1',
          name: 'Dashboard 1',
          archived: false,
          is_favorite: false,
          owner_id: 'u',
          created_at: '',
          updated_at: '',
        } as never,
      ],
      summariesLoaded: true,
      summariesLoading: false,
      dashboard: null,
      loading: false,
      loadError: false,
      conflict: false,
      loadSummaries: vi.fn().mockResolvedValue(undefined),
      createDashboard: vi.fn(),
      archiveDashboard: vi.fn(),
      deleteDashboard: vi.fn(),
      toggleFavorite: vi.fn(),
      renameDashboard: vi.fn(),
      loadDashboard: vi.fn(),
      saveLayout: vi.fn(),
      addWidget: vi.fn(),
      removeWidget: vi.fn(),
      updateWidget: vi.fn(),
      handleDashboardEvent: vi.fn(),
      handleContentEvent: vi.fn(),
      resolveConflict: vi.fn(),
    })
  })

  it('renders a drag handle per row when the "all" filter is active with 3 non-archived lists', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [
        makeList({ id: 'a', name: 'A' }),
        makeList({ id: 'b', name: 'B' }),
        makeList({ id: 'c', name: 'C' }),
      ],
      loading: false,
      error: null,
    })
    renderLayout()
    expect(screen.getAllByLabelText('Reorder list')).toHaveLength(3)
    expect(sortableListSpy).toHaveBeenCalledWith(false, expect.any(Function))
  })

  it('renders no drag handle when a non-"all" type filter is selected', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [
        makeList({ id: 'a', name: 'A', list_type: 'todo' }),
        makeList({ id: 'b', name: 'B', list_type: 'todo' }),
        makeList({ id: 'c', name: 'C', list_type: 'grocery' }),
      ],
      loading: false,
      error: null,
    })
    renderLayout()
    fireEvent.click(screen.getByRole('button', { name: 'Todo' }))
    expect(screen.queryAllByLabelText('Reorder list')).toHaveLength(0)
    expect(sortableListSpy).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('renders handles on the active rows in the default Active view even when an archived list exists on the dashboard', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [
        makeList({ id: 'a', name: 'A' }),
        makeList({ id: 'b', name: 'B' }),
        makeList({ id: 'c', name: 'C' }),
        makeList({ id: 'd', name: 'D', archived: true }),
      ],
      loading: false,
      error: null,
    })
    renderLayout()
    expect(screen.getAllByLabelText('Reorder list')).toHaveLength(3)
    expect(screen.queryByText('D')).not.toBeInTheDocument()
    expect(sortableListSpy).toHaveBeenCalledWith(false, expect.any(Function))
  })

  it('shows archived lists with no drag handles when toggled to the Archived view', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [
        makeList({ id: 'a', name: 'A' }),
        makeList({ id: 'b', name: 'B' }),
        makeList({ id: 'c', name: 'C' }),
        makeList({ id: 'd', name: 'D', archived: true }),
        makeList({ id: 'e', name: 'E', archived: true }),
      ],
      loading: false,
      error: null,
    })
    renderLayout()
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    expect(screen.getByText('D')).toBeInTheDocument()
    expect(screen.getByText('E')).toBeInTheDocument()
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.queryAllByLabelText('Reorder list')).toHaveLength(0)
    expect(sortableListSpy).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('renders no drag handle with fewer than 2 lists', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [makeList({ id: 'a', name: 'A' })],
      loading: false,
      error: null,
    })
    renderLayout()
    expect(screen.queryAllByLabelText('Reorder list')).toHaveLength(0)
    expect(sortableListSpy).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('wires the SortableList onReorder callback to reorderLists(dashboardId, orderedIds)', () => {
    mockedUseListSummaries.mockReturnValue({
      data: [
        makeList({ id: 'a', name: 'A' }),
        makeList({ id: 'b', name: 'B' }),
        makeList({ id: 'c', name: 'C' }),
      ],
      loading: false,
      error: null,
    })
    renderLayout()
    const onReorder = sortableListSpy.mock.calls[0][1] as (orderedIds: string[]) => void
    onReorder(['b', 'a', 'c'])
    expect(reorderLists).toHaveBeenCalledWith('d1', ['b', 'a', 'c'])
  })
})
