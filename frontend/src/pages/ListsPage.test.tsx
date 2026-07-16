// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListSummary } from '../api/lists'
import { useDashboardStore } from '../stores/dashboard'
import { ListDetailPage } from './ListDetailPage'
import { ListsLayout } from './ListsLayout'

vi.mock('../resources/listData', () => ({
  addListItem: vi.fn(),
  archiveList: vi.fn(),
  createList: vi.fn(),
  deleteList: vi.fn(),
  deleteListItem: vi.fn(),
  updateListItem: vi.fn(),
  updateListName: vi.fn(),
  useListSummaries: vi.fn(),
  useListDetail: vi.fn(),
}))

import { deleteList, useListDetail, useListSummaries } from '../resources/listData'

const mockedUseListSummaries = vi.mocked(useListSummaries)
const mockedUseListDetail = vi.mocked(useListDetail)

function makeSummary(overrides: Partial<ListSummary> = {}): ListSummary {
  return {
    id: 'list-1',
    dashboard_id: 'dash-1',
    name: 'Weekend chores',
    list_type: 'checklist',
    archived: false,
    created_by: 'user-1',
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    item_count: 1,
    ...overrides,
  }
}

function makeDetail(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    ...makeSummary(),
    items: [
      {
        id: 'item-1',
        list_id: 'list-1',
        text: 'Take out recycling',
        checked: false,
        sort_order: 0,
        due_date: null,
        priority: null,
        category: null,
        assigned_to: null,
        created_by: 'user-1',
        created_at: '2026-04-21T00:00:00Z',
        updated_at: '2026-04-21T00:00:00Z',
      },
    ],
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname + location.search}</p>
}

function renderLists(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/lists"
          element={
            <>
              <ListsLayout />
              <LocationProbe />
            </>
          }
        >
          <Route path=":listId" element={<ListDetailPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ListsLayout / ListDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useDashboardStore.setState({
      summaries: [
        {
          id: 'dash-1',
          user_id: 'user-1',
          name: 'Home',
          archived: false,
          access_description: 'Owned by you',
          is_shared: false,
          can_edit: true,
          can_manage_shares: true,
          is_favorite: false,
          version: 1,
          created_at: '2026-04-21T00:00:00Z',
          updated_at: '2026-04-21T00:00:00Z',
        },
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

  it('renders the selected list directly from the URL path', async () => {
    const groceriesSummary = makeSummary({ id: 'list-2', name: 'Groceries', list_type: 'grocery' })
    const groceriesDetail = makeDetail({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
      items: [
        {
          id: 'item-2',
          list_id: 'list-2',
          text: 'Bananas',
          checked: false,
          sort_order: 0,
          due_date: null,
          priority: null,
          category: null,
          assigned_to: null,
          created_by: 'user-1',
          created_at: '2026-04-21T00:00:00Z',
          updated_at: '2026-04-21T00:00:00Z',
        },
      ],
    })

    mockedUseListSummaries.mockReturnValue({
      data: [makeSummary(), groceriesSummary],
      loading: false,
      error: null,
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-2' ? groceriesDetail : null,
      loading: false,
      error: null,
    }))

    renderLists('/lists/list-2?dashboard_id=dash-1')

    expect(await screen.findByText('Bananas')).toBeInTheDocument()
  })

  it('navigates to the list path when a list row is clicked', async () => {
    const groceriesSummary = makeSummary({ id: 'list-2', name: 'Groceries', list_type: 'grocery' })
    const groceriesDetail = makeDetail({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
      items: [
        {
          id: 'item-2',
          list_id: 'list-2',
          text: 'Bananas',
          checked: false,
          sort_order: 0,
          due_date: null,
          priority: null,
          category: null,
          assigned_to: null,
          created_by: 'user-1',
          created_at: '2026-04-21T00:00:00Z',
          updated_at: '2026-04-21T00:00:00Z',
        },
      ],
    })

    mockedUseListSummaries.mockReturnValue({
      data: [makeSummary(), groceriesSummary],
      loading: false,
      error: null,
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-2' ? groceriesDetail : null,
      loading: false,
      error: null,
    }))

    renderLists('/lists?dashboard_id=dash-1')

    fireEvent.click(screen.getByRole('button', { name: 'Open list Groceries' }))

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/lists/list-2?dashboard_id=dash-1')
    })
    expect(await screen.findByText('Bananas')).toBeInTheDocument()
  })

  it('navigates back to the index when deleting the selected list', async () => {
    vi.mocked(deleteList).mockResolvedValue(undefined)

    mockedUseListSummaries.mockReturnValue({
      data: [makeSummary({ archived: true })],
      loading: false,
      error: null,
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-1' ? makeDetail() : null,
      loading: false,
      error: null,
    }))

    renderLists('/lists/list-1?dashboard_id=dash-1')

    await screen.findByText('Take out recycling')

    // The list is archived, so it's hidden from the default Active sidebar view — switch to
    // Archived to reach its row (and the Delete action, which only archived rows expose).
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    fireEvent.click(screen.getByTitle('Delete'))
    fireEvent.click(screen.getByTitle('Confirm delete'))

    await waitFor(() => {
      expect(vi.mocked(deleteList)).toHaveBeenCalledWith('list-1')
    })
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/lists?dashboard_id=dash-1')
    })
  })

  it('stays on the list path when deleting fails', async () => {
    vi.mocked(deleteList).mockRejectedValue(new Error('Failed to delete list.'))

    mockedUseListSummaries.mockReturnValue({
      data: [makeSummary({ archived: true })],
      loading: false,
      error: null,
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-1' ? makeDetail() : null,
      loading: false,
      error: null,
    }))

    renderLists('/lists/list-1?dashboard_id=dash-1')

    await screen.findByText('Take out recycling')

    // The list is archived, so it's hidden from the default Active sidebar view — switch to
    // Archived to reach its row (and the Delete action, which only archived rows expose).
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    fireEvent.click(screen.getByTitle('Delete'))
    fireEvent.click(screen.getByTitle('Confirm delete'))

    await waitFor(() => {
      expect(vi.mocked(deleteList)).toHaveBeenCalledWith('list-1')
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/lists/list-1?dashboard_id=dash-1')
  })
})
