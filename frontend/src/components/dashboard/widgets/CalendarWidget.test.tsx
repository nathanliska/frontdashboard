// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { CalendarWidget } from './CalendarWidget'

vi.mock('../../../resources/calendarData', () => ({
  useCalendarOccurrences: () => ({ data: [], loading: false, error: null, refetch: vi.fn() }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every observed element reports `height`, standing in for the widget's own measured size. */
function observeHeight(height: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      report: ResizeObserverCallback
      constructor(report: ResizeObserverCallback) {
        this.report = report
      }
      observe() {
        this.report([{ contentRect: { width: 600, height } } as never], this as never)
      }
      disconnect() {}
    },
  )
}

it.each([
  [319, true],
  [320, false],
])('tightens the month spacing in a widget %ipx tall: %s', (height, tight) => {
  observeHeight(height)
  render(
    <MemoryRouter>
      <CalendarWidget widgetId="widget" dashboardId="board" config={{ view: 'month' }} />
    </MemoryRouter>,
  )
  const grid = screen.getAllByRole('link', { name: /Open day/ })[0].parentElement
  expect(grid?.classList.contains('gap-0.5')).toBe(tight)
})
