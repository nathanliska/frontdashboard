import type { CalendarOccurrence } from '../../api/calendar'

export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const CALENDAR_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
export const CALENDAR_WEEKDAY_LABELS_COMPACT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

export function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function startOfWeek(date: Date): Date {
  const next = startOfDay(date)
  return addDays(next, -next.getDay())
}

export function calendarWindow(monthDate: Date): { start: string; end: string } {
  const monthStart = startOfMonth(monthDate)
  const gridStart = startOfWeek(monthStart)
  const gridEnd = addDays(gridStart, 42)
  return {
    start: gridStart.toISOString(),
    end: gridEnd.toISOString(),
  }
}

export function dateKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Format a bare `YYYY-MM-DD` calendar day (a list item's `due_date`) as e.g. "Jul 25".
 *
 * Split by hand instead of `new Date(day)`: that reads a bare date as UTC midnight, so anywhere
 * west of Greenwich it renders as the *previous* day. A due date has no time and no zone, and it
 * has to survive display as the same day the user picked.
 */
export function formatCalendarDay(day: string): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  return new Date(year, month - 1, dayOfMonth).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

export function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

export function formatHeadingDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export function formatDayNumber(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
  }).format(date)
}

// Built once: a formatter is costly to construct, and these run for every pill on every render.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

export function formatOccurrenceTime(start: string, end: string, allDay: boolean): string {
  if (allDay) return 'All day'
  return `${TIME_FORMAT.format(new Date(start))} - ${TIME_FORMAT.format(new Date(end))}`
}

/**
 * An occurrence's time, or its dates when it runs past one day.
 *
 * Days are the viewer's, as they are where the grid places the occurrence — so the text never
 * says one day while the event sits on two.
 */
export function formatOccurrenceSpan(start: string, end: string, allDay: boolean): string {
  if (!spansDays(start, end)) return formatOccurrenceTime(start, end, allDay)
  if (allDay) {
    return `${DAY_FORMAT.format(new Date(start))} - ${DAY_FORMAT.format(lastCoveredDay(end))}`
  }
  return `${DATE_TIME_FORMAT.format(new Date(start))} - ${DATE_TIME_FORMAT.format(new Date(end))}`
}

type CalendarOccurrenceCellLabelVariant = 'full' | 'compact'

function formatCellTime(value: string, variant: CalendarOccurrenceCellLabelVariant): string {
  if (variant === 'compact') {
    const d = new Date(value)
    let h = d.getHours()
    const m = d.getMinutes()
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`
  }

  return TIME_FORMAT.format(new Date(value))
}

export function formatCalendarOccurrenceCellLabel(
  occurrence: CalendarOccurrence,
  day: Date,
  variant: CalendarOccurrenceCellLabelVariant = 'full',
): string {
  const prefix = calendarOccurrenceCellPrefix(occurrence, day, variant)
  return prefix ? `${prefix} ${occurrence.title}` : occurrence.title
}

/** What a cell says before the title: the time, or where in a multi-day span this day falls. */
export function calendarOccurrenceCellPrefix(
  occurrence: CalendarOccurrence,
  day: Date,
  variant: CalendarOccurrenceCellLabelVariant = 'full',
): string {
  if (occurrence.all_day) {
    return variant === 'compact' ? '' : 'All day'
  }

  if (!isMultiDayOccurrence(occurrence)) {
    return formatCellTime(occurrence.occurrence_start, variant)
  }

  const dayId = dateKey(day)
  if (dayId === dateKey(occurrence.occurrence_start)) {
    return `${variant === 'compact' ? 'Start' : 'Starts'} ${formatCellTime(occurrence.occurrence_start, variant)}`
  }
  if (dayId === dateKey(lastCoveredDay(occurrence.occurrence_end))) {
    return `${variant === 'compact' ? 'End' : 'Ends'} ${formatCellTime(occurrence.occurrence_end, variant)}`
  }
  return variant === 'compact' ? 'Cont.' : 'Continues'
}

export function formatCalendarOccurrenceCellTitle(
  occurrence: CalendarOccurrence,
  day: Date,
): string {
  if (!isMultiDayOccurrence(occurrence)) {
    return `${occurrence.title}: ${formatOccurrenceTime(
      occurrence.occurrence_start,
      occurrence.occurrence_end,
      occurrence.all_day,
    )}`
  }

  return `${formatCalendarOccurrenceCellLabel(occurrence, day)} (${formatOccurrenceSpan(
    occurrence.occurrence_start,
    occurrence.occurrence_end,
    occurrence.all_day,
  )})`
}

export function toLocalInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

export function defaultLocalDateTime(hoursFromNow: number): string {
  const date = new Date()
  date.setMinutes(0, 0, 0)
  date.setHours(date.getHours() + hoursFromNow)
  return toLocalInputValue(date)
}

export function occursOnDate(occurrence: CalendarOccurrence, day: Date): boolean {
  const start = new Date(occurrence.occurrence_start)
  const end = new Date(occurrence.occurrence_end)
  const dayStart = startOfDay(day)
  const dayEnd = addDays(dayStart, 1)
  return start < dayEnd && end > dayStart
}

/**
 * The last instant an occurrence covers. Its end is exclusive — a one-day all-day event ends at the
 * next midnight, and a timed event may end exactly on one — so day math must use this instead.
 */
export function lastCoveredDay(end: string): Date {
  return new Date(Date.parse(end) - 1)
}

/** Whether the last instant covered falls on a later local day than the start. */
export function spansDays(start: string, end: string): boolean {
  return dateKey(start) !== dateKey(lastCoveredDay(end))
}

export function isMultiDayOccurrence(occurrence: CalendarOccurrence): boolean {
  return spansDays(occurrence.occurrence_start, occurrence.occurrence_end)
}

export function occurrencesForDate(
  occurrences: CalendarOccurrence[],
  day: Date,
): CalendarOccurrence[] {
  return occurrences.filter((occurrence) => occursOnDate(occurrence, day))
}

export function monthGridDays(monthDate: Date): Date[] {
  const monthStart = startOfMonth(monthDate)
  const gridStart = startOfWeek(monthStart)
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
}

export function monthWeeksInView(monthDate: Date): Date[] {
  const month = monthDate.getMonth()
  const days = monthGridDays(monthDate)

  for (let end = days.length; end > 0; end -= 7) {
    const week = days.slice(end - 7, end)
    if (week.some((day) => day.getMonth() === month)) {
      return days.slice(0, end)
    }
  }

  return days
}

/** "1 event" or "3 events", for a label a screen reader will read aloud. */
export function formatEventCount(count: number): string {
  return `${count} ${count === 1 ? 'event' : 'events'}`
}
