// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, it, vi } from 'vitest'
import { useDashboardStore } from '../stores/dashboard'
import { CalendarPage } from './CalendarPage'

// 5am to 5am on this clock: a whole day in a zone other than the editor's.
const { event, update } = vi.hoisted(() => ({
  event: {
    id: 'event',
    dashboard_id: 'home',
    title: 'Field trip',
    description: null,
    location: null,
    starts_at: new Date(2026, 3, 13, 5).toISOString(),
    ends_at: new Date(2026, 3, 14, 5).toISOString(),
    timezone: 'America/New_York',
    all_day: true,
    recurrence: null,
    participants: [],
  },
  update: vi.fn(),
}))

vi.mock('../resources/calendarData', async () => ({
  ...(await vi.importActual('../resources/calendarData')),
  getCalendarEvent: () => Promise.resolve(event),
  updateCalendarEvent: update,
  useCalendarOccurrences: () => ({
    data: [
      {
        ...event,
        event_id: event.id,
        original_start: event.starts_at,
        occurrence_start: event.starts_at,
        occurrence_end: event.ends_at,
        recurring: false,
        is_exception: false,
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

it('renames an all-day event without sending its schedule', async () => {
  useDashboardStore.setState({
    summaries: [{ id: 'home', name: 'Home', can_edit: true }],
    summariesLoading: false,
    loadSummaries: () => Promise.resolve(),
  } as never)
  render(
    <MemoryRouter initialEntries={['/calendar?dashboard_id=home&date=2026-04-13']}>
      <CalendarPage />
    </MemoryRouter>,
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Edit event' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Event title' }), {
    target: { value: 'Museum trip' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

  await waitFor(() => expect(update).toHaveBeenCalledOnce())
  expect(update.mock.calls[0][1]).toEqual({
    title: 'Museum trip',
    description: null,
    location: null,
    participants: [],
  })
})
