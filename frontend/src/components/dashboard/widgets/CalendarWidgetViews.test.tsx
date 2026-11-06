// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeOccurrence } from '../../../test/fixtures'
import { stubResizeObserver } from '../../../test/resizeObserver'
import { dateKey } from '../../../utils/calendar/calendarUtils'
import { MonthCalendarWidget, monthCellIsOneLine, WeekCalendarWidget } from './CalendarWidgetViews'

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each(['week', 'month', 'line'] as const)(
  'opens a day on its own dashboard from the %s view',
  (view) => {
    const days = [new Date(2028, 1, 29)]
    const shared = {
      dashboardId: 'second-board',
      days,
      occurrencesByDate: new Map(),
    }
    if (view === 'line') stubResizeObserver({ width: 700, height: 10 })
    render(
      <MemoryRouter>
        {view === 'week' ? (
          <WeekCalendarWidget {...shared} />
        ) : (
          <MonthCalendarWidget
            {...shared}
            compact={false}
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
  stubResizeObserver({ width: 700, height: 38 })
  const day = new Date(2028, 1, 29)
  const event = (index: number) =>
    makeOccurrence({
      event_id: `event-${index}`,
      occurrence_start: new Date(2028, 1, 29, 9 + index).toISOString(),
      occurrence_end: new Date(2028, 1, 29, 10 + index).toISOString(),
      title: `Event ${index}`,
    })
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
  const title = screen.getByText('Event 0')
  expect(title).toHaveClass('fade-end')
  expect(screen.queryByText('Event 1')).not.toBeInTheDocument()
  // Too narrow for even that title, a dot stands in; CSS decides, against the row's container.
  const pill = screen.getByTitle(/Event 0/)
  expect(pill.parentElement).toHaveClass('@container')
  expect(pill).toHaveClass('@max-[36px]:hidden')
  expect(pill.nextElementSibling).toHaveClass('hidden', '@max-[36px]:block')
  expect(screen.getByText('+2').title.split('\n')).toHaveLength(2)
})

it('keeps pills under the date while a cell has room for one', () => {
  // Border, padding and the gap under the date (14px), a 16px pill, then the 9px date.
  expect(monthCellIsOneLine(39)).toBe(false)
  expect(monthCellIsOneLine(38)).toBe(true)
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
  stubResizeObserver({ width: 700, height: 80 })
  const { unmount } = render(month(false))
  expect(screen.getByText('13')).toHaveClass('text-[9px]')
  expect(screen.getByRole('link', { name: /February 13/ })).not.toHaveClass('flex-col')
  unmount()

  render(month(true))
  expect(screen.getByRole('link', { name: /February 13/ })).toHaveClass('flex-col')
})

describe('the measured month grid', () => {
  const day = new Date(2028, 1, 29)
  const event = (index: number) =>
    makeOccurrence({
      event_id: `event-${index}`,
      occurrence_start: new Date(2028, 1, 29, 9 + index).toISOString(),
      occurrence_end: new Date(2028, 1, 29, 10 + index).toISOString(),
      title: `Event ${index}`,
    })
  const month = (count = 3) => (
    <MemoryRouter>
      <MonthCalendarWidget
        dashboardId="board"
        days={[day]}
        occurrencesByDate={
          new Map([[dateKey(day), Array.from({ length: count }, (_, index) => event(index))]])
        }
        compact={false}
        tight={false}
        monthDate={day}
        view="month"
        viewCompact={false}
        onViewChange={() => {}}
      />
    </MemoryRouter>
  )
  const grid = () => screen.getByRole('link', { name: /February 29/ }).parentElement

  it('stays hidden until measured, then shows', () => {
    const { unmount } = render(month())
    expect(grid()).toHaveClass('invisible')
    unmount()

    stubResizeObserver({ width: 700, height: 120 })
    render(month())
    expect(grid()).not.toHaveClass('invisible')
  })

  it('derives the pill rows from the grid: 57px cells hold two under the date, 56px one', () => {
    stubResizeObserver({ width: 700, height: 57 })
    const { unmount } = render(month())
    expect(screen.getAllByText(/Event \d/)).toHaveLength(2)
    unmount()

    stubResizeObserver({ width: 700, height: 56 })
    render(month())
    expect(screen.getAllByText(/Event \d/)).toHaveLength(1)
  })
})

it('moves only the gaps inside the grid with `tight`, never the grid’s own height', () => {
  // The layout is chosen from the grid's measured height; spacing outside the grid that followed
  // `tight` would make that measurement one spacing out of date for a frame.
  const day = new Date(2028, 1, 29)
  const month = (tight: boolean) => (
    <MemoryRouter>
      <MonthCalendarWidget
        dashboardId="board"
        days={[day]}
        occurrencesByDate={new Map()}
        compact={false}
        tight={tight}
        monthDate={day}
        view="month"
        viewCompact={false}
        onViewChange={() => {}}
      />
    </MemoryRouter>
  )
  const outside = () => {
    const grid = screen.getByRole('link', { name: /February 29/ }).parentElement as HTMLElement
    const siblings = [...(grid.parentElement?.children ?? [])].filter((e) => e !== grid)
    return siblings.map((e) => [...e.classList].filter((c) => /^(m|p)[btxy]?-/.test(c)).join(' '))
  }
  const { unmount } = render(month(false))
  const roomy = outside()
  unmount()
  render(month(true))
  expect(outside()).toEqual(roomy)
})

it('shortens a narrow week cell’s weekday to one letter, then to none, in CSS', () => {
  const day = new Date(2028, 1, 29)
  render(
    <MemoryRouter>
      <WeekCalendarWidget dashboardId="board" days={[day]} occurrencesByDate={new Map()} />
    </MemoryRouter>,
  )
  const cell = screen.getByRole('link', { name: /February 29/ })
  const short = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)
  const narrow = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(day)
  expect(cell).toHaveClass('@container')
  expect(screen.getByText(short)).toHaveClass('@max-[52px]:hidden')
  expect(screen.getByText(narrow)).toHaveClass('hidden', '@min-[40px]:@max-[52px]:inline')
})
