import { describe, expect, it } from 'vitest'
import { syncCreateDraftToSelectedDate } from './calendarEditorDraftUtils'

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
