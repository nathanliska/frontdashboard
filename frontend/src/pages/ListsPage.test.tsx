import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail, ListSummary } from '../api/lists'
import { useDashboardStore } from '../stores/dashboard'
import { ListsPage } from './ListsPage'

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

import { useListDetail, useListSummaries } from '../resources/listData'

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

describe('ListsPage', () => {
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

  it('restores the selected list from the URL on load', async () => {
    const groceriesSummary = makeSummary({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
      item_count: 1,
    })
    const groceriesDetail = makeDetail({
      id: 'list-2',
      name: 'Groceries',
      list_type: 'grocery',
      item_count: 1,
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

    mockedUseListSummaries.mockImplementation((dashboardId) => ({
      data: dashboardId ? [makeSummary(), groceriesSummary] : [],
      loading: false,
      error: null,
    }))
    mockedUseListDetail.mockImplementation((listId) => ({
      data: listId === 'list-2' ? groceriesDetail : null,
      loading: false,
      error: null,
    }))

    render(
      <MemoryRouter initialEntries={['/lists?dashboard_id=dash-1&list_id=list-2']}>
        <Routes>
          <Route path="/lists" element={<ListsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Bananas')).toBeInTheDocument()
  })
})
