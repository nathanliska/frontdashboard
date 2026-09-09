import { afterEach, describe, expect, it, vi } from 'vitest'
import { dateKey } from './calendarUtils'
import { parseCalendarDate } from './parseCalendarDate'

afterEach(() => vi.useRealTimers())

describe('calendar date links', () => {
  it('reads a calendar date at local midnight', () => {
    const date = parseCalendarDate('2028-02-29')
    expect(dateKey(date)).toBe('2028-02-29')
    expect(date.getHours()).toBe(0)
  })

  it.each([null, '', '2026-02-30', '2026-13-01', '2026-09-06T00:00:00Z', 'invalid'])(
    'falls back to today for %s',
    (value) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 8, 6, 14))
      expect(dateKey(parseCalendarDate(value))).toBe('2026-09-06')
    },
  )
})
