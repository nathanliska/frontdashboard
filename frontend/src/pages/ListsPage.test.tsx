// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubDashboardStore } from '../test/dashboard-store'
import {
  makeDashboardSummary,
  makeListDetail,
  makeListItem,
  makeListSummary,
} from '../test/fixtures'
import { ListDetailPage } from './ListDetailPage'
import { ListsLayout } from './ListsLayout'

vi.mock('../resources/listData', () => ({
  addListItem: vi.fn(),
  restoreList: vi.fn(),
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

    stubDashboardStore({
      summaries: [makeDashboardSummary({ id: 'dash-1', name: 'Home' })],
    })
  })

  it('renders the selected list directly from the URL path', async () => {
    const groceriesSummary = makeListSummary({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
    })
    const groceriesDetail = makeListDetail({
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
      data: [makeListSummary(), groceriesSummary],
      loading: false,
      error: null,
      refetch: () => {},
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-2' ? groceriesDetail : null,
      loading: false,
      error: null,
      refetch: () => {},
    }))

    renderLists('/lists/list-2?dashboard_id=dash-1')

    expect(await screen.findByText('Bananas')).toBeInTheDocument()
  })

  it('navigates to the list path when a list row is clicked', async () => {
    const groceriesSummary = makeListSummary({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
    })
    const groceriesDetail = makeListDetail({
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
      data: [makeListSummary(), groceriesSummary],
      loading: false,
      error: null,
      refetch: () => {},
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-2' ? groceriesDetail : null,
      loading: false,
      error: null,
      refetch: () => {},
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
      data: [makeListSummary()],
      loading: false,
      error: null,
      refetch: () => {},
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-1' ? makeListDetail({ items: [makeListItem()] }) : null,
      loading: false,
      error: null,
      refetch: () => {},
    }))

    renderLists('/lists/list-1?dashboard_id=dash-1')

    await screen.findByText('Take out recycling')

    // Delete is offered on every row now (trash is recoverable), behind an inline confirm.
    fireEvent.click(screen.getByTitle('Move to trash'))
    fireEvent.click(screen.getByTitle('Confirm move to trash'))

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
      data: [makeListSummary()],
      loading: false,
      error: null,
      refetch: () => {},
    })
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-1' ? makeListDetail({ items: [makeListItem()] }) : null,
      loading: false,
      error: null,
      refetch: () => {},
    }))

    renderLists('/lists/list-1?dashboard_id=dash-1')

    await screen.findByText('Take out recycling')

    // Delete is offered on every row now (trash is recoverable), behind an inline confirm.
    fireEvent.click(screen.getByTitle('Move to trash'))
    fireEvent.click(screen.getByTitle('Confirm move to trash'))

    await waitFor(() => {
      expect(vi.mocked(deleteList)).toHaveBeenCalledWith('list-1')
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/lists/list-1?dashboard_id=dash-1')
  })
})
