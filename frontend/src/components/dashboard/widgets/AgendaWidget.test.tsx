// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgendaItem } from '../../../resources/agendaData'
import { AgendaWidget } from './AgendaWidget'

const agenda = vi.hoisted(() => ({ items: [] as AgendaItem[] }))

vi.mock('../../../resources/agendaData', () => ({
  useAgendaItems: () => ({ data: agenda.items, error: null, refetch: vi.fn() }),
}))

function event(id: string, title: string, startsAt: string): AgendaItem {
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
})
