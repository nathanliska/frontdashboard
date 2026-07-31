// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarOccurrence } from '../api/calendar'
import { resetOccurrences, useOccurrences } from './occurrenceStore'

const { apiListOccurrences } = vi.hoisted(() => ({ apiListOccurrences: vi.fn() }))

vi.mock('../api/calendar', () => ({ apiListOccurrences }))

const DAY = 24 * 60 * 60 * 1000
const BASE = Date.parse('2026-04-01T00:00:00Z')
const iso = (offsetDays: number) => new Date(BASE + offsetDays * DAY).toISOString()

function makeOccurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    event_id: 'event-1',
    occurrence_start: iso(3),
    occurrence_end: iso(3.1),
    original_start: iso(3),
    title: 'Launch review',
    description: null,
    location: null,
    timezone: 'UTC',
    all_day: false,
    created_by: 'user-1',
    recurring: false,
    is_exception: false,
    ...overrides,
  }
}

/** Stands in for one of the three things that read occurrences, each with its own window. */
function Probe({ from, to, label }: { from: number; to: number; label: string }) {
  const { data } = useOccurrences('dash-1', iso(from), iso(to))
  return (
    <p data-testid={label}>
      {label}:{data.length}
    </p>
  )
}

describe('occurrenceStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetOccurrences()
    apiListOccurrences.mockResolvedValue([makeOccurrence()])
  })

  it('serves a contained window from an enclosing one without a second request', async () => {
    // The page's 42-day window, then the widget's 8-day window inside it.
    const { rerender } = render(<Probe from={0} to={42} label="page" />)
    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(1))

    rerender(
      <>
        <Probe from={0} to={42} label="page" />
        <Probe from={1} to={9} label="widget" />
      </>,
    )

    await screen.findByTestId('widget')
    // The assertion that matters: both windows hold the event, and it was fetched once. Asserting
    // on the rendered data alone would pass against a cache that refetched, since the second
    // request returns the same occurrence.
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('widget')).toHaveTextContent('widget:1')
    expect(screen.getByTestId('page')).toHaveTextContent('page:1')
  })

  it('coalesces widgets that mount together into a single request', async () => {
    // The dashboard case: an agenda widget and a calendar widget, overlapping windows, same tick.
    render(
      <>
        <Probe from={0} to={8} label="agenda" />
        <Probe from={0} to={42} label="calendar" />
      </>,
    )

    await waitFor(() => expect(screen.getByTestId('agenda')).toHaveTextContent('agenda:1'))
    expect(apiListOccurrences).toHaveBeenCalledTimes(1)
  })

  it('fetches only the uncovered part when a window extends past coverage', async () => {
    render(<Probe from={0} to={10} label="first" />)
    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(1))

    render(<Probe from={0} to={20} label="second" />)
    await waitFor(() => expect(apiListOccurrences).toHaveBeenCalledTimes(2))

    const secondCall = apiListOccurrences.mock.calls[1][0]
    expect(secondCall.windowStart).toBe(iso(10))
    expect(secondCall.windowEnd).toBe(iso(20))
  })

  it('drops occurrences the server stops returning for a refetched range', async () => {
    render(<Probe from={0} to={10} label="only" />)
    await waitFor(() => expect(screen.getByTestId('only')).toHaveTextContent('only:1'))

    apiListOccurrences.mockResolvedValue([])
    resetOccurrences()
    render(<Probe from={0} to={10} label="after" />)

    await waitFor(() => expect(screen.getByTestId('after')).toHaveTextContent('after:0'))
  })
})
