// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDashboardStore } from '../stores/dashboard'
import { CalendarPage } from './CalendarPage'

const query = vi.hoisted(() =>
  vi.fn(() => ({ data: [], loading: false, error: null, refetch: vi.fn() })),
)
vi.mock('../resources/calendarData', async () => ({
  ...(await vi.importActual('../resources/calendarData')),
  useCalendarOccurrences: query,
}))

function Location() {
  return <output data-testid="location">{useLocation().search}</output>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  query.mockClear()
  useDashboardStore.setState({
    summaries: [
      { id: 'first', name: 'First dashboard', can_edit: true },
      { id: 'wanted', name: 'Requested dashboard', can_edit: true },
    ],
    summariesLoading: false,
  } as never)
})

it('keeps the requested date and waits for dashboard selection before fetching', async () => {
  let finish!: () => void
  useDashboardStore.setState({
    loadSummaries: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  })
  render(
    <MemoryRouter initialEntries={['/calendar?dashboard_id=wanted&date=2028-02-29']}>
      <CalendarPage />
      <Location />
    </MemoryRouter>,
  )
  expect(query.mock.calls.every((call) => (call as unknown[])[2] === null)).toBe(true)
  expect(screen.getByTestId('location')).toHaveTextContent('dashboard_id=wanted&date=2028-02-29')
  await act(async () => finish())
  await waitFor(() =>
    expect(query).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'wanted'),
  )
  expect(query.mock.calls.every((call) => (call as unknown[])[2] !== 'first')).toBe(true)
  expect(screen.getByRole('button', { name: /February 29.*Show day/ })).toBeInTheDocument()
  expect(screen.getByTestId('location')).toHaveTextContent('date=2028-02-29')
})

it('shrinks the date badge in a cell too narrow to fit "+N" beside the full one', () => {
  // Every observed element reports the given width, as the page's one cell-body observer would.
  const observe = (width: number) =>
    vi.stubGlobal(
      'ResizeObserver',
      class {
        report: ResizeObserverCallback
        constructor(report: ResizeObserverCallback) {
          this.report = report
        }
        observe() {
          this.report([{ contentRect: { width, height: 60 } } as never], this as never)
        }
        disconnect() {}
      },
    )
  const page = () => (
    <MemoryRouter initialEntries={['/calendar?dashboard_id=wanted&date=2028-02-29']}>
      <CalendarPage />
    </MemoryRouter>
  )
  const badge = () =>
    screen.getByRole('button', { name: /February 29.*Show day/ }).querySelector('span')

  observe(40)
  const { unmount } = render(page())
  expect(badge()).not.toHaveClass('text-[9px]')
  unmount()

  observe(39)
  render(page())
  expect(badge()).toHaveClass('text-[9px]')
})
