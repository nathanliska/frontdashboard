// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, it } from 'vitest'
import { MonthCalendarWidget, WeekCalendarWidget } from './CalendarWidgetViews'

it.each(['week', 'month', 'compact'] as const)(
  'opens a day on its own dashboard from the %s view',
  (view) => {
    const days = [new Date(2028, 1, 29)]
    const shared = {
      dashboardId: 'second-board',
      days,
      occurrencesByDate: new Map(),
      compact: false,
    }
    render(
      <MemoryRouter>
        {view === 'week' ? (
          <WeekCalendarWidget {...shared} />
        ) : (
          <MonthCalendarWidget
            {...shared}
            ultraCompact={view === 'compact'}
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
