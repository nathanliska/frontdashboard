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
  it('starts weeks on sunday', () => {
    // April 15 2026 is a Wednesday; previous Sunday is April 12
    const weekStart = startOfWeek(new Date(2026, 3, 15, 12))
    expect(dateKey(weekStart)).toBe('2026-04-12')
  })

  it('builds a six-week month grid and matching fetch window', () => {
    // April 2026: Apr 1 = Wednesday, grid starts Sun Mar 29
    const monthDate = new Date(2026, 3, 15, 12)

    const days = monthGridDays(monthDate)
    const window = calendarWindow(monthDate)

    expect(days).toHaveLength(42)
    expect(dateKey(days[0])).toBe('2026-03-29')
    expect(dateKey(days[41])).toBe('2026-05-09')
    expect(dateKey(new Date(window.start))).toBe('2026-03-29')
    expect(dateKey(new Date(window.end))).toBe('2026-05-10')
  })

  it('shows only weeks that include days from the requested month', () => {
    // April 2026: Apr 1 = Wed, grid Sun Mar 29 → 5 weeks (35 days)
    const fiveWeekMonth = monthWeeksInView(new Date(2026, 3, 15, 12))
    // May 2026: May 1 = Fri, grid Sun Apr 26 → 6 weeks (42 days, May 31 anchors week 6)
    const sixWeekMonth = monthWeeksInView(new Date(2026, 4, 15, 12))
    // Feb 2026: Feb 1 = Sun, grid starts Feb 1 → exactly 4 weeks (28 days)
    const fourWeekMonth = monthWeeksInView(new Date(2026, 1, 15, 12))

    expect(fiveWeekMonth).toHaveLength(35)
    expect(dateKey(fiveWeekMonth[0])).toBe('2026-03-29')
    expect(dateKey(fiveWeekMonth[34])).toBe('2026-05-02')

    expect(sixWeekMonth).toHaveLength(42)
    expect(dateKey(sixWeekMonth[0])).toBe('2026-04-26')
    expect(dateKey(sixWeekMonth[41])).toBe('2026-06-06')

    expect(fourWeekMonth).toHaveLength(28)
    expect(dateKey(fourWeekMonth[0])).toBe('2026-02-01')
    expect(dateKey(fourWeekMonth[27])).toBe('2026-02-28')
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
      participants: [],
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
      participants: [],
    }

    expect(isMultiDayOccurrence(sameDayOccurrence)).toBe(false)
  })

  it('keeps a one-day all-day occurrence single-day despite its exclusive midnight end', () => {
    // The all-day normalization stores "all of Apr 10" as [Apr 10 00:00, Apr 11 00:00) — the end
    // instant is not covered, so it must not read as spilling into Apr 11.
    const start = new Date(2026, 3, 10, 0, 0)
    const end = new Date(2026, 3, 11, 0, 0)
    const oneDayAllDay = {
      event_id: 'event-4',
      occurrence_start: start.toISOString(),
      occurrence_end: end.toISOString(),
      original_start: start.toISOString(),
      title: 'Universal Studios',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: true,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
      participants: [],
    }

    expect(isMultiDayOccurrence(oneDayAllDay)).toBe(false)
    expect(
      isMultiDayOccurrence({
        ...oneDayAllDay,
        occurrence_end: new Date(2026, 3, 12, 0, 0).toISOString(),
      }),
    ).toBe(true)
  })

  it('keeps a timed occurrence ending exactly at midnight single-day', () => {
    const start = new Date(2026, 3, 10, 20, 0)
    const end = new Date(2026, 3, 11, 0, 0)
    const eveningUntilMidnight = {
      event_id: 'event-5',
      occurrence_start: start.toISOString(),
      occurrence_end: end.toISOString(),
      original_start: start.toISOString(),
      title: 'Game night',
      description: null,
      location: null,
      timezone: 'UTC',
      all_day: false,
      created_by: 'user-1',
      recurring: false,
      is_exception: false,
      participants: [],
    }

    expect(isMultiDayOccurrence(eveningUntilMidnight)).toBe(false)
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
      participants: [],
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
      participants: [],
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
