// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListDetail } from '../api/lists'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboardSummary, makeListItem, makeListSummary } from '../test/fixtures'
import { ListDetailPage } from './ListDetailPage'

vi.mock('../resources/listData', () => ({
  addListItem: vi.fn(),
  deleteListItem: vi.fn(),
  reorderListItems: vi.fn(),
  updateListItem: vi.fn(),
  updateListName: vi.fn(),
  useListDetail: vi.fn(),
}))

import { addListItem, updateListItem, useListDetail } from '../resources/listData'

const mockedUseListDetail = vi.mocked(useListDetail)

function makeDetail(): ListDetail {
  return {
    ...makeListSummary({ item_count: 3 }),
    items: [
      makeListItem({ id: 'item-bread', text: 'Bread', sort_order: 0 }),
      makeListItem({
        id: 'item-milk',
        text: 'Milk',
        sort_order: 1,
        checked: true,
      }),
      makeListItem({ id: 'item-eggs', text: 'Eggs', sort_order: 2 }),
    ],
  }
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/lists/list-1']}>
      <Routes>
        <Route path="/lists/:listId" element={<ListDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ListDetailPage checked pile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    stubDashboardStore({ summaries: [makeDashboardSummary({ id: 'dash-1', name: 'Home' })] })
    mockedUseListDetail.mockReturnValue({
      data: makeDetail(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
  })

  it('sinks checked items into a collapsed pile by default', () => {
    renderDetail()
    const pileToggle = screen.getByRole('button', { name: 'Checked (1)' })
    expect(pileToggle).toHaveAttribute('aria-expanded', 'false')
    // Collapsed pile hides the row; the active zone keeps only unchecked items.
    expect(screen.queryByText('Milk')).not.toBeInTheDocument()
    expect(screen.getByText('Bread')).toBeInTheDocument()
    expect(screen.getByText('Eggs')).toBeInTheDocument()
  })

  it('expands the pile on demand and unchecks from it', () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Checked (1)' }))
    const pile = screen.getByRole('region', { name: 'Checked items' })
    fireEvent.click(within(pile).getByRole('button', { name: 'Uncheck' }))
    expect(updateListItem).toHaveBeenCalledWith('list-1', 'item-milk', { checked: false })
  })

  it('reserves the drag-handle footprint on pile rows so text columns align', () => {
    const { container } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Checked (1)' }))
    // Active rows show handles (2 sortable items), so the unsortable pile row must indent.
    // Asserted on the row first: `row?.querySelector` on a missing row yields undefined, which
    // satisfies not.toBeNull() and would pass having checked nothing.
    const pileRow = container.querySelector('[data-item-id="item-milk"]')
    expect(pileRow).not.toBeNull()
    expect(pileRow?.querySelector('span[aria-hidden="true"]')).not.toBeNull()
  })

  it('keeps the footprint reserved once too few items are left to sort', () => {
    // Sorting switches off below two active items. Tying the indent to that count instead of
    // to the list shifts every remaining row left the moment the last one is checked.
    mockedUseListDetail.mockReturnValue({
      data: {
        ...makeListSummary({ item_count: 2 }),
        items: [
          makeListItem({ id: 'item-bread', text: 'Bread', sort_order: 0, checked: true }),
          makeListItem({ id: 'item-milk', text: 'Milk', sort_order: 1, checked: true }),
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    const { container } = renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Checked (2)' }))
    expect(screen.getByText('All checked.')).toBeInTheDocument()
    for (const id of ['item-bread', 'item-milk']) {
      const row = container.querySelector(`[data-item-id="${id}"]`)
      expect(row).not.toBeNull()
      expect(row?.querySelector('span[aria-hidden="true"]')).not.toBeNull()
    }
  })

  it('renders checked items in place when the pile is toggled off, and remembers it', () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Sink checked items into a pile' }))
    expect(screen.getByText('Milk')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Checked (1)' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem('listPile:list-1')).toBe('0')
  })

  it('re-reads the new list’s pile preference when only the route param changes', () => {
    // The route element is never remounted across :listId changes, so the preference must
    // come from a subscription keyed on listId, not from mount-time state.
    mockedUseListDetail.mockImplementation((listId) => ({
      data:
        listId === 'list-2'
          ? {
              ...makeListSummary({ id: 'list-2', name: 'Second', item_count: 1 }),
              items: [
                makeListItem({
                  id: 'item-2',
                  list_id: 'list-2',
                  text: 'Cheese',
                  checked: true,
                }),
              ],
            }
          : makeDetail(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    }))
    render(
      <MemoryRouter initialEntries={['/lists/list-1']}>
        <Link to="/lists/list-2">next-list</Link>
        <Routes>
          <Route path="/lists/:listId" element={<ListDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    // Turn the pile off for list 1 only.
    fireEvent.click(screen.getByRole('button', { name: 'Sink checked items into a pile' }))
    expect(screen.queryByRole('button', { name: 'Checked (1)' })).not.toBeInTheDocument()

    // List 2 keeps its own (default-on) preference rather than inheriting list 1's state.
    fireEvent.click(screen.getByText('next-list'))
    expect(screen.getByRole('button', { name: 'Checked (1)' })).toBeInTheDocument()
    expect(window.localStorage.getItem('listPile:list-2')).toBeNull()
  })

  it('restores a checked item from the add box instead of duplicating it', () => {
    renderDetail()
    const input = screen.getByRole('combobox', { name: 'Add item' })
    fireEvent.change(input, { target: { value: 'milk' } })
    fireEvent.submit(input)
    expect(updateListItem).toHaveBeenCalledWith('list-1', 'item-milk', { checked: false })
    expect(addListItem).not.toHaveBeenCalled()
  })
})
