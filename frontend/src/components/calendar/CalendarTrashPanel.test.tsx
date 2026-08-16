// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfirmStore } from '../../stores/confirm'
import { CalendarTrashPanel } from './CalendarTrashPanel'

const { apiGetEventTrash, restoreCalendarEvent, purgeCalendarEvent } = vi.hoisted(() => ({
  apiGetEventTrash: vi.fn(),
  restoreCalendarEvent: vi.fn(),
  purgeCalendarEvent: vi.fn(),
}))

vi.mock('../../api/calendar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/calendar')>()),
  apiGetEventTrash,
}))

vi.mock('../../resources/calendarData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../resources/calendarData')>()),
  restoreCalendarEvent,
  purgeCalendarEvent,
}))

vi.mock('../../stores/toast', async () => (await import('../../test/toast')).toastMock())

function makeEntry(overrides = {}) {
  return {
    id: 'event-1',
    dashboard_id: 'dash-1',
    title: 'Bin day',
    starts_at: '2026-08-14T09:00:00Z',
    all_day: false,
    recurring: false,
    deleted_at: '2026-08-14T10:00:00Z',
    purge_at: '2026-09-13T10:00:00Z',
    ...overrides,
  }
}

/** A trash response. `next_cursor` is what the panel reads; it never counts rows. */
function page(
  items: ReturnType<typeof makeEntry>[],
  nextCursor: { deleted_at: string; id: string } | null = null,
) {
  return { items, next_cursor: nextCursor }
}

describe('CalendarTrashPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useConfirmStore.getState().reset()
    apiGetEventTrash.mockResolvedValue(page([makeEntry()]))
    restoreCalendarEvent.mockResolvedValue(true)
    purgeCalendarEvent.mockResolvedValue(true)
  })

  it('restores an event and drops it from the list', async () => {
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Restore Bin day' }))

    // Refetching occurrences belongs to `restoreCalendarEvent`, not to this component — the toast
    // undo needs it too, and calendarData.test.tsx is where it is proven.
    await waitFor(() => expect(restoreCalendarEvent).toHaveBeenCalledWith('event-1', 'dash-1'))
    await waitFor(() => expect(screen.queryByText('Bin day')).not.toBeInTheDocument())
  })

  it('asks before purging, and does nothing if the confirm is declined', async () => {
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Permanently delete Bin day' }))
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))

    act(() => useConfirmStore.getState()._cancel())

    expect(purgeCalendarEvent).not.toHaveBeenCalled()
    expect(await screen.findByText('Bin day')).toBeVisible()
  })

  it('purges once confirmed', async () => {
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Permanently delete Bin day' }))
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true))
    act(() => useConfirmStore.getState()._accept())

    await waitFor(() => expect(purgeCalendarEvent).toHaveBeenCalledWith('event-1'))
    await waitFor(() => expect(screen.queryByText('Bin day')).not.toBeInTheDocument())
  })

  it('says the window is 30 days when the trash is empty', async () => {
    apiGetEventTrash.mockResolvedValue(page([]))
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    expect(await screen.findByText(/stay here for 30 days/i)).toBeVisible()
  })

  it('says the load failed rather than claiming the trash is empty', async () => {
    apiGetEventTrash.mockRejectedValue(new Error('Failed to load trashed events'))
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    // The distinction the user acts on: an outage must not read as "your deleted events are gone".
    expect(await screen.findByText(/couldn't load the trash/i)).toBeVisible()
    expect(screen.queryByText(/nothing in the trash/i)).not.toBeInTheDocument()

    apiGetEventTrash.mockResolvedValue(page([makeEntry()]))
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('Bin day')).toBeVisible()
  })

  const CURSOR = { deleted_at: '2026-08-14T09:00:00Z', id: 'a-199' }

  it('offers no way to load more when the server names no next cursor', async () => {
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    expect(await screen.findByText('Bin day')).toBeVisible()
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('takes the end from the cursor, not from how many rows arrived', async () => {
    // A page long enough to look "full" to anything counting rows, but the server says it is the
    // last one. Counting instead would offer a next page that comes back empty.
    const full = Array.from({ length: 200 }, (_, i) => makeEntry({ id: `a-${i}`, title: `a ${i}` }))
    apiGetEventTrash.mockResolvedValue(page(full, null))
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    expect(await screen.findByText('a 0')).toBeVisible()
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('hands the cursor straight back and appends the next page', async () => {
    apiGetEventTrash
      .mockResolvedValueOnce(page([makeEntry({ id: 'a-0', title: 'Newer' })], CURSOR))
      .mockResolvedValueOnce(page([makeEntry({ id: 'b-0', title: 'Older' })], null))
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /load older/i }))

    // Passed through untouched — the client never constructs or interprets it.
    await waitFor(() => expect(apiGetEventTrash).toHaveBeenLastCalledWith('dash-1', CURSOR))
    // Appended, not replaced: the first page is still on screen above the new rows.
    expect(await screen.findByText('Older')).toBeVisible()
    expect(screen.getByText('Newer')).toBeVisible()
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('keeps what is on screen when loading more fails', async () => {
    apiGetEventTrash
      .mockResolvedValueOnce(page([makeEntry({ id: 'a-0', title: 'Newer' })], CURSOR))
      .mockRejectedValueOnce(new Error('nope'))
    render(<CalendarTrashPanel dashboardId="dash-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /load older/i }))

    // A failed second page is not a failed trash: the rows already fetched are still recoverable,
    // and the cursor survives so the button can be tried again.
    await waitFor(() => expect(screen.getByRole('button', { name: /load older/i })).toBeEnabled())
    expect(screen.getByText('Newer')).toBeVisible()
    expect(screen.queryByText(/couldn't load the trash/i)).not.toBeInTheDocument()
  })
})
