import { describe, expect, it } from 'vitest'
import {
  buildEventUpdateFromDraft,
  type CalendarEditorDraft,
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
