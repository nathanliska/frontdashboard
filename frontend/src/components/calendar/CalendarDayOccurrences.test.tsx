// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeOccurrence } from '../../test/fixtures'
import { CalendarDayOccurrences, fitOccurrenceRows } from './CalendarDayOccurrences'

const DAY = new Date(2026, 3, 10)
const HEADING = <span>10</span>

const occurrence = (index: number) =>
  makeOccurrence({
    event_id: `event-${index}`,
    occurrence_start: new Date(2026, 3, 10, 9 + index).toISOString(),
    occurrence_end: new Date(2026, 3, 10, 10 + index).toISOString(),
    title: `Event ${index}`,
  })

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

  it('lets a narrow body give up the time, the dots and the ellipsis for the title, in CSS', () => {
    const withParticipant = {
      ...occurrence(0),
      participants: [{ user_id: 'user-2', display_name: 'Sam', is_member: true }],
    }
    render(
      <CalendarDayOccurrences
        heading={HEADING}
        occurrences={[withParticipant]}
        day={DAY}
        height={200}
        density="month"
      />,
    )
    const pill = screen.getByTitle(/Event 0/)
    // The body is the container every variant below answers to; jsdom cannot see the width.
    expect(pill.parentElement).toHaveClass('@container')
    expect(pill).toHaveClass('@max-[80px]:px-0.5')
    expect(pill.querySelector('[style*="background"]')?.parentElement).toHaveClass(
      '@max-[80px]:hidden',
    )
    expect(screen.getByText('9AM')).toHaveClass('@max-[80px]:hidden')
    expect(pill.textContent).toBe('9AM Event 0')
    expect(screen.getByText('Event 0')).toHaveClass('@max-[80px]:text-clip', '@max-[80px]:fade-end')
  })
})
