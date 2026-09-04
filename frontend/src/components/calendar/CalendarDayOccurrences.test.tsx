// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CalendarOccurrence } from '../../api/calendar'
import { CalendarDayOccurrences, fitOccurrenceRows } from './CalendarDayOccurrences'

const DAY = new Date(2026, 3, 10)

function occurrence(index: number): CalendarOccurrence {
  const start = new Date(2026, 3, 10, 9 + index)
  const end = new Date(2026, 3, 10, 10 + index)
  return {
    event_id: `event-${index}`,
    occurrence_start: start.toISOString(),
    occurrence_end: end.toISOString(),
    original_start: start.toISOString(),
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

describe('fitOccurrenceRows', () => {
  const ROW = 19
  const GAP = 4
  // Three rows to the pixel: two gaps between them, and no trailing gap under the last.
  const THREE_ROWS = ROW * 3 + GAP * 2

  it('counts the last row that fits without counting a gap below it', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 3)).toEqual({ visible: 3, hidden: 0 })
    expect(fitOccurrenceRows(THREE_ROWS - 1, ROW, 3)).toEqual({ visible: 1, hidden: 2 })
  })

  it('spends a row on the "+N" line rather than hiding an event silently', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 4)).toEqual({ visible: 2, hidden: 2 })
  })

  it('shows everything when everything fits', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 0)).toEqual({ visible: 0, hidden: 0 })
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 2)).toEqual({ visible: 2, hidden: 0 })
  })

  it('keeps one row in a cell too short for any, so a busy day still says so', () => {
    expect(fitOccurrenceRows(0, ROW, 3)).toEqual({ visible: 0, hidden: 3 })
    expect(fitOccurrenceRows(0, ROW, 1)).toEqual({ visible: 1, hidden: 0 })
  })
})

describe('CalendarDayOccurrences', () => {
  const events = [occurrence(0), occurrence(1), occurrence(2), occurrence(3)]
  // The height that separates the two densities: 88px is four month rows but only three week
  // rows, so a density mapped to the wrong pitch changes what renders rather than nothing.
  const SPLIT_HEIGHT = 88

  it('fits one fewer row at week density than at month density', () => {
    const { unmount } = render(
      <CalendarDayOccurrences
        occurrences={events}
        day={DAY}
        height={SPLIT_HEIGHT}
        density="week"
      />,
    )
    expect(screen.getAllByText(/Event \d/)).toHaveLength(2)
    expect(screen.getByText('+2')).toBeInTheDocument()
    unmount()

    render(
      <CalendarDayOccurrences
        occurrences={events}
        day={DAY}
        height={SPLIT_HEIGHT}
        density="month"
      />,
    )
    expect(screen.getAllByText(/Event \d/)).toHaveLength(4)
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument()
  })

  it('names the events the "+N" line stands for, the only way to reach them', () => {
    render(<CalendarDayOccurrences occurrences={events} day={DAY} height={50} density="month" />)
    const overflow = screen.getByText('+3')
    expect(overflow.title).toContain('Event 1')
    expect(overflow.title).toContain('Event 3')
    expect(overflow.title.split('\n')).toHaveLength(3)
  })

  it('drops the time prefix when told to show titles alone', () => {
    const { unmount } = render(
      <CalendarDayOccurrences occurrences={[events[0]]} day={DAY} height={200} density="week" />,
    )
    expect(screen.queryByText('Event 0')).not.toBeInTheDocument()
    expect(screen.getByText(/Event 0$/).textContent).not.toBe('Event 0')
    unmount()

    render(
      <CalendarDayOccurrences
        occurrences={[events[0]]}
        day={DAY}
        height={200}
        density="week"
        titleOnly
      />,
    )
    expect(screen.getByText('Event 0')).toBeInTheDocument()
  })
})
