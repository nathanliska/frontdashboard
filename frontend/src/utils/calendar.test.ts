import { describe, expect, it } from 'vitest'
import {
  calendarWindow,
  dateKey,
  isMultiDayOccurrence,
  monthGridDays,
  occursOnDate,
  startOfWeek,
} from './calendar'

describe('calendar utils', () => {
  it('starts weeks on monday', () => {
    const weekStart = startOfWeek(new Date(2026, 3, 15, 12))
    expect(dateKey(weekStart)).toBe('2026-04-13')
  })

  it('builds a six-week month grid and matching fetch window', () => {
    const monthDate = new Date(2026, 3, 15, 12)

    const days = monthGridDays(monthDate)
    const window = calendarWindow(monthDate)

    expect(days).toHaveLength(42)
    expect(dateKey(days[0])).toBe('2026-03-30')
    expect(dateKey(days[41])).toBe('2026-05-10')
    expect(dateKey(new Date(window.start))).toBe('2026-03-30')
    expect(dateKey(new Date(window.end))).toBe('2026-05-11')
  })

  it('treats overlapping occurrences as visible on a day', () => {
    const overnightStart = new Date(2026, 3, 10, 23, 30)
    const overnightEnd = new Date(2026, 3, 11, 1, 0)
    const overnightOccurrence = {
      event_id: 'event-1',
      occurrence_start: overnightStart.toISOString(),
      occurrence_end: overnightEnd.toISOString(),
      original_start: overnightStart.toISOString(),
      title: 'Late shift',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
    }

    expect(occursOnDate(overnightOccurrence, new Date(2026, 3, 10, 12))).toBe(true)
    expect(occursOnDate(overnightOccurrence, new Date(2026, 3, 11, 12))).toBe(true)
    expect(occursOnDate(overnightOccurrence, new Date(2026, 3, 12, 12))).toBe(false)
    expect(isMultiDayOccurrence(overnightOccurrence)).toBe(true)
  })

  it('keeps same-day occurrences as single-day items', () => {
    const sameDayStart = new Date(2026, 3, 10, 14, 0)
    const sameDayEnd = new Date(2026, 3, 10, 15, 0)
    const sameDayOccurrence = {
      event_id: 'event-2',
      occurrence_start: sameDayStart.toISOString(),
      occurrence_end: sameDayEnd.toISOString(),
      original_start: sameDayStart.toISOString(),
      title: 'Dentist',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
    }

    expect(isMultiDayOccurrence(sameDayOccurrence)).toBe(false)
  })
})
