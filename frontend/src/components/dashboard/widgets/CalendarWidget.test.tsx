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
