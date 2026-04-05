import type { CalendarOccurrence } from '../api/calendar'

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

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function startOfWeek(date: Date): Date {
  const next = startOfDay(date)
  const mondayOffset = (next.getDay() + 6) % 7
  return addDays(next, -mondayOffset)
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

export function formatOccurrenceTime(start: string, end: string, allDay: boolean): string {
  if (allDay) return 'All day'

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`
}

export function formatOccurrenceSpan(start: string, end: string, allDay: boolean): string {
  if (allDay) return 'All day'

  const startDate = new Date(start)
  const endDate = new Date(end)
  const sameDay = dateKey(startDate) === dateKey(endDate)

  if (sameDay) {
    return formatOccurrenceTime(start, end, allDay)
  }

  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  return `${dateTimeFormatter.format(startDate)} - ${dateTimeFormatter.format(endDate)}`
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

export function isMultiDayOccurrence(occurrence: CalendarOccurrence): boolean {
  return dateKey(occurrence.occurrence_start) !== dateKey(occurrence.occurrence_end)
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
