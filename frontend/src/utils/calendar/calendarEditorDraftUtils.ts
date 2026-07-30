import type { CalendarEvent, UpdateCalendarEventInput } from '../../api/calendar'
import { dateKey, defaultLocalDateTime, toLocalInputValue } from './calendarUtils'

export type RecurrenceMode = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export type EditorMode = 'create' | 'edit'
export type CalendarEditorDraft = {
  title: string
  description: string
  eventLocation: string
  startsAt: string
  endsAt: string
  allDay: boolean
  recurrenceMode: RecurrenceMode
  recurrenceInterval: string
  recurrenceWeekdays: number[]
  recurrenceEndsOn: string
}

export const WEEKDAY_PICKER_OPTIONS = [
  { label: 'S', name: 'Sun', value: 6 },
  { label: 'M', name: 'Mon', value: 0 },
  { label: 'T', name: 'Tue', value: 1 },
  { label: 'W', name: 'Wed', value: 2 },
  { label: 'R', name: 'Thu', value: 3 },
  { label: 'F', name: 'Fri', value: 4 },
  { label: 'S', name: 'Sat', value: 5 },
] as const

export function createDefaultCalendarEditorDraft(baseDate?: Date): CalendarEditorDraft {
  const { startsAt, endsAt } = createDefaultEventWindow(baseDate)
  return {
    title: '',
    description: '',
    eventLocation: '',
    startsAt,
    endsAt,
    allDay: false,
    recurrenceMode: 'none',
    recurrenceInterval: '1',
    recurrenceWeekdays: [],
    recurrenceEndsOn: '',
  }
}

export function createCalendarEditorDraftFromEvent(event: CalendarEvent): CalendarEditorDraft {
  return {
    title: event.title,
    description: event.description ?? '',
    eventLocation: event.location ?? '',
    startsAt: toLocalDateTimeInput(event.starts_at),
    endsAt: toLocalDateTimeInput(event.ends_at),
    allDay: event.all_day,
    recurrenceMode: event.recurrence?.frequency ?? 'none',
    recurrenceInterval: String(event.recurrence?.interval ?? 1),
    recurrenceWeekdays: getInitialWeeklySelection(event.starts_at, event.recurrence),
    recurrenceEndsOn: event.recurrence
      ? deriveRecurrenceEndDate(event.starts_at, event.recurrence)
      : '',
  }
}

export function syncCreateDraftToSelectedDate({
  selectedDate,
  startsAt,
  endsAt,
  recurrenceMode,
  recurrenceWeekdays,
}: {
  selectedDate: Date
  startsAt: string
  endsAt: string
  recurrenceMode: RecurrenceMode
  recurrenceWeekdays: number[]
}): Pick<CalendarEditorDraft, 'startsAt' | 'endsAt' | 'recurrenceWeekdays'> {
  const fallbackDraft = createDefaultCalendarEditorDraft(selectedDate)
  const nextStartsAt = applyDateToDateTimeInput(startsAt, selectedDate) ?? fallbackDraft.startsAt
  const durationToPreserve =
    getDurationMinutesValue(startsAt, endsAt) ??
    getDurationMinutesValue(fallbackDraft.startsAt, fallbackDraft.endsAt) ??
    60

  const nextStartDate = new Date(nextStartsAt)
  const nextEndDate = new Date(nextStartDate)
  nextEndDate.setMinutes(nextEndDate.getMinutes() + durationToPreserve)

  return {
    startsAt: nextStartsAt,
    endsAt: toLocalDateTimeValue(nextEndDate),
    recurrenceWeekdays: syncWeeklySelectionWithStartDate(
      recurrenceMode,
      startsAt,
      nextStartsAt,
      recurrenceWeekdays,
    ),
  }
}

export function toMondayWeekday(jsDay: number): number {
  return (jsDay + 6) % 7
}

export function getRecurringOverlapWarning(
  startsAt: string,
  endsAt: string,
  mode: RecurrenceMode,
  intervalValue: string,
): string | null {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  const interval = Math.max(1, Number(intervalValue) || 1)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null

  const nextStart = new Date(start)
  switch (mode) {
    case 'daily':
      nextStart.setDate(nextStart.getDate() + interval)
      break
    case 'weekly':
      nextStart.setDate(nextStart.getDate() + interval * 7)
      break
    case 'monthly':
      nextStart.setMonth(nextStart.getMonth() + interval)
      break
    case 'yearly':
      nextStart.setFullYear(nextStart.getFullYear() + interval)
      break
    default:
      return null
  }

  if (end <= nextStart) return null
  return 'This event lasts longer than the repeat interval, so repeated occurrences will overlap each other.'
}

export function repeatUnitLabel(mode: RecurrenceMode, interval: number): string {
  const plural = interval === 1 ? '' : 's'
  switch (mode) {
    case 'daily':
      return `day${plural}`
    case 'weekly':
      return `week${plural}`
    case 'monthly':
      return `month${plural}`
    case 'yearly':
      return `year${plural}`
    default:
      return 'time'
  }
}

export function formatWeeklySelection(weekdays: number[]): string {
  const selected = WEEKDAY_PICKER_OPTIONS.filter((option) => weekdays.includes(option.value)).map(
    (option) => option.name,
  )
  return selected.length > 0 ? selected.join(', ') : 'the selected day'
}

export function getInitialWeeklySelection(
  startsAt: string,
  recurrence: {
    frequency: string
    interval: number
    until?: string
    count?: number
    by_weekday?: number[]
  } | null,
): number[] {
  if (recurrence?.frequency === 'weekly' && recurrence.by_weekday?.length) {
    return [...new Set(recurrence.by_weekday)].sort((a, b) => a - b)
  }
  return recurrence?.frequency === 'weekly' ? [toMondayWeekday(new Date(startsAt).getDay())] : []
}

export function deriveRecurrenceEndDate(
  startsAt: string,
  recurrence: {
    frequency: string
    interval: number
    until?: string
    count?: number
    by_weekday?: number[]
  },
): string {
  if (recurrence.until) return toLocalDateInput(recurrence.until)
  if (!recurrence.count || recurrence.count <= 1) return ''

  const date = new Date(startsAt)
  const repeatsToAdvance = recurrence.count - 1
  for (let index = 0; index < repeatsToAdvance; index += 1) {
    switch (recurrence.frequency) {
      case 'daily':
        date.setDate(date.getDate() + recurrence.interval)
        break
      case 'weekly':
        date.setDate(date.getDate() + recurrence.interval * 7)
        break
      case 'monthly':
        date.setMonth(date.getMonth() + recurrence.interval)
        break
      case 'yearly':
        date.setFullYear(date.getFullYear() + recurrence.interval)
        break
      default:
        return ''
    }
  }
  return toLocalDateInput(date.toISOString())
}

export function toRecurrenceUntilIso(value: string): string {
  return new Date(`${value}T23:59:59`).toISOString()
}

function createDefaultEventWindow(baseDate?: Date): {
  startsAt: string
  endsAt: string
} {
  if (!baseDate || dateKey(baseDate) === dateKey(new Date())) {
    return {
      startsAt: defaultLocalDateTime(1),
      endsAt: defaultLocalDateTime(2),
    }
  }

  const start = new Date(baseDate)
  start.setHours(9, 0, 0, 0)

  const end = new Date(baseDate)
  end.setHours(10, 0, 0, 0)

  return {
    startsAt: toLocalInputValue(start),
    endsAt: toLocalInputValue(end),
  }
}

function toLocalDateInput(value: string): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function getDurationMinutesValue(startsAt: string, endsAt: string): number | null {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  return Math.round((end.getTime() - start.getTime()) / 60000)
}

function applyDateToDateTimeInput(value: string, targetDate: Date): string | null {
  const current = new Date(value)
  if (Number.isNaN(current.getTime())) return null

  const next = new Date(targetDate)
  next.setHours(current.getHours(), current.getMinutes(), 0, 0)
  return toLocalDateTimeValue(next)
}

function toLocalDateTimeValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`
}

function syncWeeklySelectionWithStartDate(
  recurrenceMode: RecurrenceMode,
  previousStartsAt: string,
  nextStartsAt: string,
  recurrenceWeekdays: number[],
): number[] {
  if (recurrenceMode !== 'weekly') return recurrenceWeekdays

  const nextStartWeekday = getLocalInputWeekday(nextStartsAt)
  if (nextStartWeekday == null) return recurrenceWeekdays
  if (recurrenceWeekdays.length === 0) return [nextStartWeekday]

  const previousStartWeekday = getLocalInputWeekday(previousStartsAt)
  if (
    previousStartWeekday != null &&
    recurrenceWeekdays.length === 1 &&
    recurrenceWeekdays[0] === previousStartWeekday
  ) {
    return recurrenceWeekdays[0] === nextStartWeekday ? recurrenceWeekdays : [nextStartWeekday]
  }

  return recurrenceWeekdays
}

function getLocalInputWeekday(value: string): number | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return toMondayWeekday(date.getDay())
}

export function formatEndDateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

export function toLocalDateTimeInput(value: string): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * The PATCH body for an edited event.
 *
 * Beside `createCalendarEditorDraftFromEvent` because it is that function's inverse, and the pair
 * has to agree on how an empty field round-trips. `null` is the only way to say "clear this" —
 * `JSON.stringify` drops `undefined`, which the server reads as "leave unchanged".
 */
export function buildEventUpdateFromDraft(
  draft: CalendarEditorDraft,
  recurrence: UpdateCalendarEventInput['recurrence'],
  timezone: string,
): UpdateCalendarEventInput {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    location: draft.eventLocation.trim() || null,
    starts_at: new Date(draft.startsAt).toISOString(),
    ends_at: new Date(draft.endsAt).toISOString(),
    timezone,
    all_day: draft.allDay,
    recurrence,
  }
}
