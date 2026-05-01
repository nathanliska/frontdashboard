import { describe, expect, it } from 'vitest'
import {
  calendarWindow,
  dateKey,
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
  isMultiDayOccurrence,
  monthGridDays,
  monthWeeksInView,
  occursOnDate,
  startOfWeek,
} from './calendarUtils'

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

  it('shows only weeks that include days from the requested month', () => {
    const fiveWeekMonth = monthWeeksInView(new Date(2026, 3, 15, 12))
    const sixWeekMonth = monthWeeksInView(new Date(2026, 2, 15, 12))
    const fourWeekMonth = monthWeeksInView(new Date(2027, 1, 15, 12))

    expect(fiveWeekMonth).toHaveLength(35)
    expect(dateKey(fiveWeekMonth[0])).toBe('2026-03-30')
    expect(dateKey(fiveWeekMonth[34])).toBe('2026-05-03')

    expect(sixWeekMonth).toHaveLength(42)
    expect(dateKey(sixWeekMonth[0])).toBe('2026-02-23')
    expect(dateKey(sixWeekMonth[41])).toBe('2026-04-05')

    expect(fourWeekMonth).toHaveLength(28)
    expect(dateKey(fourWeekMonth[0])).toBe('2027-02-01')
    expect(dateKey(fourWeekMonth[27])).toBe('2027-02-28')
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

  it('formats shared calendar cell labels for single-day events', () => {
    const start = new Date(2026, 3, 10, 14, 0)
    const end = new Date(2026, 3, 10, 15, 0)
    const occurrence = {
      event_id: 'event-3',
      occurrence_start: start.toISOString(),
      occurrence_end: end.toISOString(),
      original_start: start.toISOString(),
      title: 'Dentist',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
    }

    expect(formatCalendarOccurrenceCellLabel(occurrence, new Date(2026, 3, 10, 12))).toBe(
      '2:00 PM Dentist',
    )
    expect(
      formatCalendarOccurrenceCellLabel(occurrence, new Date(2026, 3, 10, 12), 'compact'),
    ).toBe('2PM Dentist')
    expect(formatCalendarOccurrenceCellTitle(occurrence, new Date(2026, 3, 10, 12))).toBe(
      'Dentist: 2:00 PM - 3:00 PM',
    )
  })

  it('formats shared calendar cell labels for multi-day events', () => {
    const start = new Date(2026, 3, 10, 23, 30)
    const end = new Date(2026, 3, 11, 1, 0)
    const occurrence = {
      event_id: 'event-4',
      occurrence_start: start.toISOString(),
      occurrence_end: end.toISOString(),
      original_start: start.toISOString(),
      title: 'Late shift',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
    }

    expect(formatCalendarOccurrenceCellLabel(occurrence, new Date(2026, 3, 10, 12))).toBe(
      'Starts 11:30 PM Late shift',
    )
    expect(
      formatCalendarOccurrenceCellLabel(occurrence, new Date(2026, 3, 11, 12), 'compact'),
    ).toBe('End 1AM Late shift')
    expect(formatCalendarOccurrenceCellTitle(occurrence, new Date(2026, 3, 11, 12))).toBe(
      'Ends 1:00 AM Late shift (Apr 10, 11:30 PM - Apr 11, 1:00 AM)',
    )
  })
})
