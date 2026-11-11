// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { stubResizeObserver } from '../../../test/resizeObserver'
import { CalendarWidget } from './CalendarWidget'

vi.mock('../../../resources/calendarData', () => ({
  useCalendarOccurrences: () => ({ data: [], loading: false, error: null, refetch: vi.fn() }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([
  [600, 319, true],
  [600, 320, false],
  [459, 600, true],
  [460, 600, false],
])('tightens the month spacing in a widget %ipx wide and %ipx tall: %s', (width, height, tight) => {
  stubResizeObserver({ width, height })
  render(
    <MemoryRouter>
      <CalendarWidget widgetId="widget" dashboardId="board" config={{ view: 'month' }} />
    </MemoryRouter>,
  )
  const day = screen.getAllByRole('link', { name: /Open day/ })[0]
  expect(day.parentElement?.classList.contains('gap-0.5')).toBe(tight)
  expect(day.classList.contains('px-0.5')).toBe(tight)
})

it.each([
  [459, true],
  [460, false],
])('stacks the week into rows in a widget %ipx wide: %s', (width, list) => {
  stubResizeObserver({ width, height: 600 })
  render(
    <MemoryRouter>
      <CalendarWidget widgetId="widget" dashboardId="board" config={{ view: 'week' }} />
    </MemoryRouter>,
  )
  const grid = screen.getAllByRole('link', { name: /Open day/ })[0].parentElement
  expect(grid?.classList.contains('auto-rows-max')).toBe(list)
  expect(grid?.classList.contains('grid-cols-7')).toBe(!list)
})

it('hides the week until measured, so a wide widget never paints a frame of the stacked list', () => {
  const week = (
    <MemoryRouter>
      <CalendarWidget widgetId="widget" dashboardId="board" config={{ view: 'week' }} />
    </MemoryRouter>
  )
  const hidden = () => screen.getAllByRole('link', { name: /Open day/ })[0].closest('.invisible')
  // The setup's observer never reports, which is the frame before the first measurement.
  const { unmount } = render(week)
  expect(hidden()).not.toBeNull()
  unmount()

  stubResizeObserver({ width: 900, height: 600 })
  render(week)
  expect(hidden()).toBeNull()
})
