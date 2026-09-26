// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgendaItem } from '../../../resources/agendaData'
import { AgendaWidget } from './AgendaWidget'

const agenda = vi.hoisted(() => ({ items: [] as AgendaItem[] }))

vi.mock('../../../resources/agendaData', () => ({
  useAgendaItems: () => ({ data: agenda.items, error: null, refetch: vi.fn() }),
}))

function event(
  id: string,
  title: string,
  startsAt: string,
): Extract<AgendaItem, { type: 'event' }> {
  return {
    id,
    type: 'event',
    title,
    startsAt,
    endsAt: startsAt,
    allDay: false,
    recurring: false,
    participants: [],
  }
}

function todayAt(hour: number): string {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

function inDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}

function renderWith(items: AgendaItem[]) {
  agenda.items = items
  return render(<AgendaWidget dashboardId="dash-1" />)
}

describe('AgendaWidget', () => {
  it('spends what is left of the budget on upcoming items', () => {
    renderWith([
      ...Array.from({ length: 3 }, (_, i) => event(`t${i}`, `Task ${i}`, todayAt(9 + i))),
      ...Array.from({ length: 20 }, (_, i) => event(`u${i}`, `Later ${i}`, inDays(i + 1))),
    ])

    // Ten in total, three of them today.
    expect(screen.getAllByText(/^Later /)).toHaveLength(7)
  })

  it('drops the upcoming section when today alone exceeds the budget', () => {
    // The boundary the clamp exists for: a negative `slice` count counts from the *end*, so an
    // unclamped budget of -2 would render all but the last two upcoming items instead of none.
    renderWith([
      ...Array.from({ length: 12 }, (_, i) => event(`t${i}`, `Task ${i}`, todayAt(8 + i))),
      ...Array.from({ length: 5 }, (_, i) => event(`u${i}`, `Later ${i}`, inDays(i + 1))),
    ])

    expect(screen.getAllByText(/^Task /)).toHaveLength(12)
    expect(screen.queryByText('Upcoming')).not.toBeInTheDocument()
    expect(screen.queryByText(/^Later /)).not.toBeInTheDocument()
  })

  it('labels a multi-day event with its weekday, or Today for as long as it runs', () => {
    // A fixed clock: the labels are relative to today, and a run across midnight must not flake.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 16, 12))
    const midnight = (date: number) => new Date(2026, 8, date)
    const trip = (id: string, from: number, to: number): AgendaItem => ({
      ...event(id, `Trip ${id}`, midnight(from).toISOString()),
      endsAt: midnight(to).toISOString(),
      allDay: true,
    })
    const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
    try {
      // Running since yesterday; starting in two days; and one that ended at today's midnight,
      // which the exclusive end keeps off today.
      renderWith([trip('a', 15, 18), trip('b', 18, 21), trip('c', 13, 16)])

      expect(
        screen.getByText(`Today · ${day.format(midnight(15))} - ${day.format(midnight(17))}`),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          `${weekday.format(midnight(18))} · ${day.format(midnight(18))} - ${day.format(midnight(20))}`,
        ),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          `${weekday.format(midnight(13))} · ${day.format(midnight(13))} - ${day.format(midnight(15))}`,
        ),
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
