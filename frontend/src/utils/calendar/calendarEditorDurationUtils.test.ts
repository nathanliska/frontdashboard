import { describe, expect, it } from 'vitest'
import {
  formatDurationValue,
  getDurationMinutes,
  parseDurationValue,
  stepDurationMinutes,
} from './calendarEditorDurationUtils'

describe('parseDurationValue', () => {
  it('answers null for the states a decimal passes through while being typed', () => {
    expect(parseDurationValue('', 'hours')).toBeNull()
    expect(parseDurationValue('   ', 'hours')).toBeNull()
    expect(parseDurationValue('abc', 'hours')).toBeNull()
    expect(parseDurationValue('0', 'hours')).toBeNull()
    expect(parseDurationValue('-2', 'hours')).toBeNull()
  })

  it('reads a trailing decimal point as the whole part, so the next keystroke extends it', () => {
    expect(parseDurationValue('1.', 'hours')).toBe(60)
    expect(parseDurationValue('1.5', 'hours')).toBe(90)
  })

  it('converts through the unit', () => {
    expect(parseDurationValue('45', 'minutes')).toBe(45)
    expect(parseDurationValue('2', 'days')).toBe(2880)
  })
})

describe('stepDurationMinutes', () => {
  it('steps from the duration, not from the value shown for it', () => {
    // 90 minutes displays as `0.06` days; stepping from that would write the rounding back.
    expect(formatDurationValue(90, 'days')).toBe('0.06')
    expect(stepDurationMinutes(90, 'days', 1)).toBe(90 + 360)
  })

  it('holds at the unit minimum rather than going to zero', () => {
    expect(stepDurationMinutes(15, 'minutes', -1)).toBe(15)
    expect(stepDurationMinutes(15, 'hours', -1)).toBe(15)
  })

  it('starts from the unit minimum when there is no duration to step from', () => {
    expect(stepDurationMinutes(null, 'minutes', 1)).toBe(30)
  })

  it('steps a quarter hour in either direction', () => {
    expect(stepDurationMinutes(90, 'hours', 1)).toBe(105)
    expect(stepDurationMinutes(90, 'hours', -1)).toBe(75)
  })
})

describe('getDurationMinutes', () => {
  it('is null when the end is not after the start', () => {
    expect(getDurationMinutes('2026-08-05T09:00', '2026-08-05T09:00')).toBeNull()
    expect(getDurationMinutes('2026-08-05T09:00', '2026-08-05T08:00')).toBeNull()
    expect(getDurationMinutes('nonsense', '2026-08-05T10:00')).toBeNull()
  })
})
