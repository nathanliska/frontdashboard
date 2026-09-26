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

const HEADING = <span>10</span>

describe('fitOccurrenceRows', () => {
  const ROW = 16
  const GAP = 2
  // Three rows to the pixel: two gaps between them, and no trailing gap under the last.
  const THREE_ROWS = ROW * 3 + GAP * 2

  it('counts the last row that fits without counting a gap below it', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 3)).toEqual({ visible: 3, hidden: 0 })
    expect(fitOccurrenceRows(THREE_ROWS - 1, ROW, 3)).toEqual({ visible: 2, hidden: 1 })
  })

  it('fills every row that fits, since "+N" does not take one', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 4)).toEqual({ visible: 3, hidden: 1 })
  })

  it('shows everything when everything fits', () => {
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 0)).toEqual({ visible: 0, hidden: 0 })
    expect(fitOccurrenceRows(THREE_ROWS, ROW, 2)).toEqual({ visible: 2, hidden: 0 })
  })

  it('keeps one row in a cell too short for any, so a busy day still names an event', () => {
    expect(fitOccurrenceRows(0, ROW, 3)).toEqual({ visible: 1, hidden: 2 })
    expect(fitOccurrenceRows(0, ROW, 1)).toEqual({ visible: 1, hidden: 0 })
  })
})

describe('CalendarDayOccurrences', () => {
  const events = [occurrence(0), occurrence(1), occurrence(2), occurrence(3)]
  // The height that separates the two densities: 64px is three month rows but only two week
  // rows, so a density mapped to the wrong pitch changes what renders rather than nothing.
  const SPLIT_HEIGHT = 64

  it('fits one fewer row at week density than at month density', () => {
    const { unmount } = render(
      <CalendarDayOccurrences
        heading={HEADING}
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
        heading={HEADING}
        occurrences={events}
        day={DAY}
        height={SPLIT_HEIGHT}
        density="month"
      />,
    )
    expect(screen.getAllByText(/Event \d/)).toHaveLength(3)
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('puts "+N" on the heading line, where it costs no row', () => {
    render(
      <CalendarDayOccurrences
        heading={HEADING}
        occurrences={events}
        day={DAY}
        height={0}
        density="month"
      />,
    )
    expect(screen.getByText('+3').parentElement).toBe(screen.getByText('10').parentElement)
  })

  it('names the events the "+N" stands for, the only way to reach them in place', () => {
    render(
      <CalendarDayOccurrences
        heading={HEADING}
        occurrences={events}
        day={DAY}
        height={34}
        density="month"
      />,
    )
    const overflow = screen.getByText('+2')
    expect(overflow.title).toContain('Event 2')
    expect(overflow.title).toContain('Event 3')
    expect(overflow.title.split('\n')).toHaveLength(2)
  })

  it('drops the time prefix when told to, or when the cell is too narrow for it', () => {
    const cell = (props: { titleOnly?: boolean; width?: number }) => (
      <CalendarDayOccurrences
        heading={HEADING}
        occurrences={[events[0]]}
        day={DAY}
        height={200}
        density="week"
        {...props}
      />
    )
    const { rerender } = render(cell({ width: 80 }))
    expect(screen.queryByText('Event 0')).not.toBeInTheDocument()
    expect(screen.getByText(/Event 0$/).textContent).not.toBe('Event 0')

    rerender(cell({ width: 79 }))
    expect(screen.getByText('Event 0')).toBeInTheDocument()

    // Zero is a width not measured yet, which must not render the narrow layout's first frame.
    rerender(cell({ width: 0 }))
    expect(screen.queryByText('Event 0')).not.toBeInTheDocument()

    rerender(cell({ titleOnly: true }))
    expect(screen.getByText('Event 0')).toBeInTheDocument()
  })
})

it('drops participant dots where the cell is too narrow to spare them', () => {
  const withParticipant = {
    ...occurrence(0),
    participants: [{ user_id: 'user-2', display_name: 'Sam', is_member: true }],
  } as CalendarOccurrence
  const cell = (width: number) => (
    <CalendarDayOccurrences
      heading={HEADING}
      occurrences={[withParticipant]}
      day={DAY}
      height={200}
      width={width}
      density="month"
    />
  )
  const { rerender } = render(cell(80))
  const pill = () => screen.getByTitle(/Event 0/)
  expect(pill().children).toHaveLength(2)
  rerender(cell(79))
  expect(pill().children).toHaveLength(1)
})
