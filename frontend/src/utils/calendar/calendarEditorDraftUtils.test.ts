import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../../api/calendar'
import { RecurrenceRule } from '../../api/generated/contract'
import {
  buildEventUpdateFromDraft,
  type CalendarEditorDraft,
  createCalendarEditorDraftFromEvent,
  daysBetweenDateValues,
  exclusiveAllDayEnd,
  inclusiveAllDayEndDate,
  shiftDateValue,
  syncCreateDraftToSelectedDate,
} from './calendarEditorDraftUtils'

describe('calendar editor draft utils', () => {
  it('moves the draft to the selected date while preserving time and duration', () => {
    const synced = syncCreateDraftToSelectedDate({
      selectedDate: new Date(2026, 3, 20, 12),
      startsAt: '2026-04-13T11:00',
      endsAt: '2026-04-13T12:30',
      recurrenceMode: 'none',
      recurrenceWeekdays: [],
    })

    expect(synced.startsAt).toBe('2026-04-20T11:00')
    expect(synced.endsAt).toBe('2026-04-20T12:30')
    expect(synced.recurrenceWeekdays).toEqual([])
  })

  it('derives a repeat end date from a count-based rule', () => {
    const event = {
      id: 'e1',
      dashboard_id: 'd1',
      title: 'Standup',
      description: null,
      location: null,
      starts_at: '2026-04-13T09:00',
      ends_at: '2026-04-13T09:30',
      timezone: 'UTC',
      all_day: false,
      created_by: 'u1',
      updated_by: 'u1',
      created_at: '2026-04-01T00:00',
      updated_at: '2026-04-01T00:00',
      recurrence: { frequency: 'daily' as const, interval: 1, count: 3 },
      participants: [],
    } satisfies CalendarEvent

    const draft = createCalendarEditorDraftFromEvent(event)

    expect(draft.recurrenceEndsOn).toBe('2026-04-15')
  })

  it('fills an omitted interval at the network boundary', () => {
    // Arithmetic against an absent interval yields an Invalid Date, which renders as an empty
    // field rather than a wrong one. The contract's default is what makes that unreachable.
    expect(RecurrenceRule.parse({ frequency: 'daily', count: 3 }).interval).toBe(1)
  })

  it('keeps weekly weekday selection in sync when it only followed the old start day', () => {
    const synced = syncCreateDraftToSelectedDate({
      selectedDate: new Date(2026, 3, 16, 12),
      startsAt: '2026-04-14T09:00',
      endsAt: '2026-04-14T10:00',
      recurrenceMode: 'weekly',
      recurrenceWeekdays: [1],
    })

    expect(synced.startsAt).toBe('2026-04-16T09:00')
    expect(synced.endsAt).toBe('2026-04-16T10:00')
    expect(synced.recurrenceWeekdays).toEqual([3])
  })
})

describe('buildEventUpdateFromDraft', () => {
  function draft(overrides: Partial<CalendarEditorDraft> = {}): CalendarEditorDraft {
    return {
      title: 'Dentist',
      description: 'Bring the referral',
      eventLocation: '12 High Street',
      startsAt: '2026-04-13T11:00',
      endsAt: '2026-04-13T12:30',
      allDay: false,
      recurrenceMode: 'none',
      recurrenceInterval: '1',
      recurrenceWeekdays: [],
      recurrenceEndsOn: '',
      participants: [],
      ...overrides,
    }
  }

  it('sends the entered values', () => {
    const body = buildEventUpdateFromDraft(draft(), null, 'Europe/London')

    expect(body.description).toBe('Bring the referral')
    expect(body.location).toBe('12 High Street')
    expect(body.timezone).toBe('Europe/London')
  })

  it('sends null for a cleared location and description, never undefined', () => {
    // `undefined` is dropped by JSON.stringify, so the key never reaches the server, which reads an
    // absent key as "leave unchanged" — making the old value impossible to remove.
    const body = buildEventUpdateFromDraft(
      draft({ eventLocation: '', description: '' }),
      null,
      'UTC',
    )

    expect(body.location).toBeNull()
    expect(body.description).toBeNull()
    // The property that actually matters: the keys survive serialisation.
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({ location: null, description: null })
    expect(Object.keys(JSON.parse(JSON.stringify(body)))).toContain('location')
  })

  it('treats whitespace as cleared', () => {
    const body = buildEventUpdateFromDraft(draft({ eventLocation: '   ' }), null, 'UTC')

    expect(body.location).toBeNull()
  })
})

describe('all-day end date conversion', () => {
  it('round-trips the exclusive end through the inclusive display value', () => {
    // Stored Aug 14–17(excl) = covers the 14th through the 16th.
    expect(inclusiveAllDayEndDate('2026-08-14T00:00', '2026-08-17T00:00')).toBe('2026-08-16')
    expect(exclusiveAllDayEnd('2026-08-16')).toBe('2026-08-17T00:00')
  })

  it('derives the covered day from a timed end, midnight-exclusive', () => {
    // A timed end mid-day covers its own day; one exactly at midnight does not.
    expect(inclusiveAllDayEndDate('2026-08-05T09:00', '2026-08-07T13:00')).toBe('2026-08-07')
    expect(inclusiveAllDayEndDate('2026-08-05T09:00', '2026-08-07T00:00')).toBe('2026-08-06')
  })

  it('clamps an inverted or unusable end to a one-day event', () => {
    expect(inclusiveAllDayEndDate('2026-08-14T00:00', '2026-08-10T00:00')).toBe('2026-08-14')
    expect(inclusiveAllDayEndDate('2026-08-14T00:00', 'not-a-date')).toBe('2026-08-14')
    // And never the reverse: a cleared start must not eat a valid end.
    expect(inclusiveAllDayEndDate('T00:00', '2026-08-17T00:00')).toBe('2026-08-16')
  })

  it('does whole-day math across month ends', () => {
    expect(shiftDateValue('2026-08-31', 1)).toBe('2026-09-01')
    expect(shiftDateValue('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetweenDateValues('2026-08-30', '2026-09-02')).toBe(3)
  })
})
