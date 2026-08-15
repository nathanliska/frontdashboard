// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubDashboardStore } from '../test/dashboard-store'
import { makeDashboardSummary, makeListSummary } from '../test/fixtures'
import { ListsLayout } from './ListsLayout'

const { deleteList, restoreList, mockedUseListSummaries } = vi.hoisted(() => ({
  deleteList: vi.fn(),
  restoreList: vi.fn(),
  mockedUseListSummaries: vi.fn(),
}))

vi.mock('../resources/listData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resources/listData')>()),
  deleteList,
  restoreList,
  useListSummaries: () => mockedUseListSummaries(),
}))

vi.mock('../api/lists', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/lists')>()),
  apiGetListTrash: () => Promise.resolve([]),
}))

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))
vi.mock('../stores/toast', async () =>
  (await import('../test/toast')).toastMock({ success: toastSuccess }),
)

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

/** The action object the page handed to the success toast, if any. */
function undoAction() {
  const call = toastSuccess.mock.calls.at(-1)
  return call?.[1] as { label: string; onAction: () => void } | undefined
}

describe('deleting a list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteList.mockResolvedValue(undefined)
    restoreList.mockResolvedValue(makeListSummary({ id: 'groceries', name: 'Groceries' }))
    mockedUseListSummaries.mockReturnValue({
      data: [makeListSummary({ id: 'groceries', name: 'Groceries' })],
      loading: false,
      error: null,
    })
    stubDashboardStore({ summaries: [makeDashboardSummary({ id: 'dash-1' })] })
  })

  it('offers an undo that restores the list rather than recreating it', async () => {
    renderLayout()

    // The row confirms inline: trash icon, then a check.
    fireEvent.click(await screen.findByTitle('Move to trash'))
    fireEvent.click(await screen.findByTitle('Confirm move to trash'))

    await waitFor(() => expect(deleteList).toHaveBeenCalledWith('groceries'))

    // Assert on the action the toast carries, not the message: the recovery path is the feature,
    // and the toast reads almost identically with or without it.
    await waitFor(() => expect(undoAction()).toMatchObject({ label: 'Undo' }))

    undoAction()?.onAction()

    // restoreList, not createList — the row is in the trash, so undo brings back the same list
    // with its items, id and share inheritance intact.
    await waitFor(() => expect(restoreList).toHaveBeenCalledWith('groceries', 'dash-1'))
  })
})
