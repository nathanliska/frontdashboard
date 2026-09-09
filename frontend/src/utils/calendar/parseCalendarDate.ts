import { dateKey, startOfDay } from './calendarUtils'

/** Read a local calendar date without UTC parsing or silently normalizing an impossible day. */
export function parseCalendarDate(value: string | null): Date {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00`)
    if (Number.isFinite(parsed.getTime()) && dateKey(parsed) === value) return parsed
  }
  return startOfDay(new Date())
}
