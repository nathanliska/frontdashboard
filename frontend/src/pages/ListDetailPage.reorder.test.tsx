// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListItem } from '../api/lists'
import { useDashboardStore } from '../stores/dashboard'
import { ListDetailPage } from './ListDetailPage'

const { reorderListItems, mockedUseListDetail, sortableListSpy } = vi.hoisted(() => ({
  reorderListItems: vi.fn(),
  mockedUseListDetail: vi.fn(),
  sortableListSpy: vi.fn(),
}))

vi.mock('../resources/listData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/listData')>()),
  reorderListItems,
  useListDetail: () => mockedUseListDetail(),
}))

// SortableList's own drag-end -> onReorder(orderedIds) math is covered by
// SortableList.test.tsx. Real dnd-kit keyboard-drag simulation in jsdom is flaky
// (per the task brief), so here we replace SortableList/useSortableRow with a
// deterministic stand-in that (a) still lets ListDetailPage decide, per row, whether
// to pass a `sortable` prop to ListItemRow (so handle-count assertions below exercise
// real ListDetailPage/ListItemRow logic), and (b) exposes the `onReorder` callback
// ListDetailPage wired up, so we can invoke it directly and assert the exact call it
// makes into reorderListItems.
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

function makeItem(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: 'a',
    list_id: 'list-1',
    text: 'A',
    checked: false,
    sort_order: 0,
    due_date: null,
    priority: null,
    category: null,
    assigned_to: null,
    created_by: 'u',
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function makeDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    id: 'list-1',
    dashboard_id: 'd1',
    name: 'L',
    list_type: 'todo',
    sort_order: 0,
    archived: false,
    created_by: 'u',
    created_at: '',
    updated_at: '',
    item_count: 3,
    items: [
      makeItem({ id: 'a', text: 'A', sort_order: 0 }),
      makeItem({ id: 'b', text: 'B', sort_order: 1 }),
      makeItem({ id: 'c', text: 'C', sort_order: 2 }),
    ],
    ...overrides,
  }
}

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
    useDashboardStore.setState({
      summaries: [],
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

  it('renders a drag handle per row when reordering is enabled', () => {
    mockedUseListDetail.mockReturnValue({ data: makeDetail(), error: null })
    renderPage()
    expect(screen.getAllByLabelText('Reorder item')).toHaveLength(3)
    expect(sortableListSpy).toHaveBeenCalledWith(false, expect.any(Function))
  })

  it('renders no drag handle when the list is archived', () => {
    mockedUseListDetail.mockReturnValue({ data: makeDetail({ archived: true }), error: null })
    renderPage()
    expect(screen.queryAllByLabelText('Reorder item')).toHaveLength(0)
    expect(sortableListSpy).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('renders no drag handle when there is only one item', () => {
    mockedUseListDetail.mockReturnValue({
      data: makeDetail({
        items: [makeItem({ id: 'a', text: 'A', sort_order: 0 })],
        item_count: 1,
      }),
      error: null,
    })
    renderPage()
    expect(screen.queryAllByLabelText('Reorder item')).toHaveLength(0)
    expect(sortableListSpy).toHaveBeenCalledWith(true, expect.any(Function))
  })

  it('wires the SortableList onReorder callback to reorderListItems(listId, orderedIds)', () => {
    mockedUseListDetail.mockReturnValue({ data: makeDetail(), error: null })
    renderPage()
    const onReorder = sortableListSpy.mock.calls[0][1] as (orderedIds: string[]) => void
    onReorder(['b', 'a', 'c'])
    expect(reorderListItems).toHaveBeenCalledWith('list-1', ['b', 'a', 'c'])
  })
})
