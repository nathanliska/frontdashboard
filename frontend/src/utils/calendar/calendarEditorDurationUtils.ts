export type DurationUnit = 'minutes' | 'hours' | 'days'

export function getDurationMinutes(startsAt: string, endsAt: string): number | null {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  return Math.round((end.getTime() - start.getTime()) / 60000)
}

export function inferDurationUnit(startsAt: string, endsAt: string): DurationUnit {
  const durationMinutes = getDurationMinutes(startsAt, endsAt)
  if (durationMinutes == null) return 'hours'
  if (durationMinutes % (60 * 24) === 0) return 'days'
  if (durationMinutes % 60 === 0) return 'hours'
  return 'minutes'
}

export function formatDurationValue(durationMinutes: number | null, unit: DurationUnit): string {
  if (durationMinutes == null) return ''

  if (unit === 'minutes') return String(durationMinutes)
  if (unit === 'hours') return trimTrailingZeroes((durationMinutes / 60).toFixed(2))
  return trimTrailingZeroes((durationMinutes / (60 * 24)).toFixed(2))
}

function getDurationStep(unit: DurationUnit): number {
  if (unit === 'minutes') return 15
  if (unit === 'hours') return 0.25
  return 0.25
}

function getMinimumDurationValue(unit: DurationUnit): number {
  if (unit === 'minutes') return 15
  return 0.25
}

/**
 * The duration a step away from `durationMinutes`, in minutes, never below the unit's minimum.
 *
 * Steps in minutes rather than in the displayed value because that value is rounded for display:
 * 90 minutes reads as `0.06` days, and stepping from what is shown would write back the rounding.
 */
export function stepDurationMinutes(
  durationMinutes: number | null,
  unit: DurationUnit,
  delta: number,
): number {
  const minimum = toDurationMinutes(getMinimumDurationValue(unit), unit)
  const step = toDurationMinutes(getDurationStep(unit), unit)
  return Math.max(minimum, (durationMinutes ?? minimum) + delta * step)
}

/**
 * The duration a partially typed value means, or `null` while it means nothing yet.
 *
 * `''` and `'1.'` are what a decimal looks like mid-keystroke, so they have to be answerable
 * without the caller treating them as a duration.
 */
export function parseDurationValue(value: string, unit: DurationUnit): number | null {
  const parsed = Number(value.trim())
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) return null
  return toDurationMinutes(parsed, unit)
}

function toDurationMinutes(value: number, unit: DurationUnit): number {
  if (unit === 'minutes') return Math.round(value)
  if (unit === 'hours') return Math.round(value * 60)
  return Math.round(value * 60 * 24)
}

export function toLocalDateTimeValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function trimTrailingZeroes(value: string): string {
  return value.replace(/\.?0+$/, '')
}
