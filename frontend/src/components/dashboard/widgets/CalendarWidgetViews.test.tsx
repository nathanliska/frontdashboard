// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../../../api/calendar'
import { dateKey } from '../../../utils/calendar/calendarUtils'
import { MonthCalendarWidget, monthCellLayout, WeekCalendarWidget } from './CalendarWidgetViews'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every observed element reports `height`, standing in for the widget's measured day grid. */
function observeHeight(height: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      report: ResizeObserverCallback
      constructor(report: ResizeObserverCallback) {
        this.report = report
      }
      observe() {
        this.report([{ contentRect: { width: 300, height } } as never], this as never)
      }
      disconnect() {}
    },
  )
}

it.each(['week', 'month', 'line'] as const)(
  'opens a day on its own dashboard from the %s view',
  (view) => {
    const days = [new Date(2028, 1, 29)]
    const shared = {
      dashboardId: 'second-board',
      days,
      occurrencesByDate: new Map(),
      compact: false,
    }
    if (view === 'line') observeHeight(10)
    render(
      <MemoryRouter>
        {view === 'week' ? (
          <WeekCalendarWidget {...shared} />
        ) : (
          <MonthCalendarWidget
            {...shared}
            tight={false}
            monthDate={days[0]}
            view="month"
            viewCompact={false}
            onViewChange={() => {}}
          />
        )}
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /February 29.*Open day/ })
    expect(link).toHaveAttribute('href', '/calendar?dashboard_id=second-board&date=2028-02-29')
    link.focus()
    expect(link).toHaveFocus()
  },
)

it('folds a day too short for a pill into one line naming its first event', () => {
  // One week row: the whole grid is one cell, too short for a date over a pill.
  observeHeight(38)
  const day = new Date(2028, 1, 29)
  const event = (index: number): CalendarOccurrence => {
    const start = new Date(2028, 1, 29, 9 + index).toISOString()
    return {
      event_id: `event-${index}`,
      occurrence_start: start,
      occurrence_end: new Date(2028, 1, 29, 10 + index).toISOString(),
      original_start: start,
      title: `Event ${index}`,
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
      participants: [],
    }
  }
  render(
    <MemoryRouter>
      <MonthCalendarWidget
        dashboardId="board"
        days={[day]}
        occurrencesByDate={new Map([[dateKey(day), [event(0), event(1), event(2)]]])}
        compact
        tight={false}
        monthDate={day}
        view="month"
        viewCompact={false}
        onViewChange={() => {}}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Event 0')).toBeInTheDocument()
  expect(screen.queryByText('Event 1')).not.toBeInTheDocument()
  expect(screen.getByText('+2').title.split('\n')).toHaveLength(2)
})

it('keeps pills under the date while a cell has room for one, shrinking the date first', () => {
  // Border, padding and the gap under the date (14px), a 16px pill, then the date itself.
  expect(monthCellLayout(49)).toBe('full')
  expect(monthCellLayout(48)).toBe('compact')
  expect(monthCellLayout(39)).toBe('compact')
  expect(monthCellLayout(38)).toBe('line')
})

it('shrinks the date badge in a cell with room for a pill only under the smaller one', () => {
  const day = new Date(2028, 1, 29)
  const month = () => (
    <MemoryRouter>
      <MonthCalendarWidget
        dashboardId="board"
        days={[day]}
        occurrencesByDate={new Map()}
        compact={false}
        tight={false}
        monthDate={day}
        view="month"
        viewCompact={false}
        onViewChange={() => {}}
      />
    </MemoryRouter>
  )
  const badge = () => screen.getByText('29')

  observeHeight(49)
  const { unmount } = render(month())
  expect(badge()).not.toHaveClass('text-[9px]')
  unmount()

  observeHeight(48)
  render(month())
  expect(badge()).toHaveClass('text-[9px]')
})

it('counts the tight grid gap when judging whether two weeks of cells can hold a pill', () => {
  const start = new Date(2028, 1, 13)
  const days = Array.from({ length: 14 }, (_, index) => new Date(2028, 1, 13 + index))
  const month = (tight: boolean) => (
    <MemoryRouter>
      <MonthCalendarWidget
        dashboardId="board"
        days={days}
        occurrencesByDate={new Map()}
        compact={false}
        tight={tight}
        monthDate={start}
        view="month"
        viewCompact={false}
        onViewChange={() => {}}
      />
    </MemoryRouter>
  )
  // An 80px grid of two rows: 38px cells across a 4px gap fold, 39px cells across 2px do not.
  observeHeight(80)
  const { unmount } = render(month(false))
  expect(screen.getByText('13')).toHaveClass('text-[9px]')
  expect(screen.getByRole('link', { name: /February 13/ })).not.toHaveClass('flex-col')
  unmount()

  render(month(true))
  expect(screen.getByRole('link', { name: /February 13/ })).toHaveClass('flex-col')
})
