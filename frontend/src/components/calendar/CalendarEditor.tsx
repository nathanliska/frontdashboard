import { Minus, Plus } from 'lucide-react'
import { type FormEvent, memo, useEffect, useEffectEvent, useState } from 'react'
import {
  type CalendarEditorDraft,
  type EditorMode,
  formatEndDateLabel,
  formatWeeklySelection,
  getRecurringOverlapWarning,
  type RecurrenceMode,
  repeatUnitLabel,
  syncCreateDraftToSelectedDate,
  toMondayWeekday,
} from '../../utils/calendar/calendarEditorDraftUtils'
import {
  type DurationUnit,
  formatDurationValue,
  getDefaultDurationValue,
  getDurationMinutes,
  getDurationStep,
  getMinimumDurationValue,
  inferDurationUnit,
  toDurationMinutes,
  toLocalDateTimeValue,
} from '../../utils/calendar/calendarEditorDurationUtils'
import { cn } from '../../utils/shared/cn'
import { CalendarEditorRepeatSection } from './CalendarEditorRepeatSection'

type RepeatCadenceMode = Exclude<RecurrenceMode, 'none'>

export const CalendarEditor = memo(function CalendarEditor({
  mode,
  initialDraft,
  selectedDate,
  activeDashboardName,
  onClose,
  onSubmit,
}: {
  mode: EditorMode
  initialDraft: CalendarEditorDraft
  selectedDate?: Date | null
  activeDashboardName?: string
  onClose: () => void
  onSubmit: (draft: CalendarEditorDraft) => Promise<void>
}) {
  const [title, setTitle] = useState(initialDraft.title)
  const [description, setDescription] = useState(initialDraft.description)
  const [eventLocation, setEventLocation] = useState(initialDraft.eventLocation)
  const [startsAt, setStartsAt] = useState(initialDraft.startsAt)
  const [endsAt, setEndsAt] = useState(initialDraft.endsAt)
  const [allDay, setAllDay] = useState(initialDraft.allDay)
  const [recurrenceMode, setRecurrenceMode] = useState<RecurrenceMode>(initialDraft.recurrenceMode)
  const [lastRecurringMode, setLastRecurringMode] = useState<RepeatCadenceMode>(
    initialDraft.recurrenceMode === 'none' ? 'weekly' : initialDraft.recurrenceMode,
  )
  const [recurrenceInterval, setRecurrenceInterval] = useState(initialDraft.recurrenceInterval)
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState(initialDraft.recurrenceWeekdays)
  const [recurrenceEndsOn, setRecurrenceEndsOn] = useState(initialDraft.recurrenceEndsOn)
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(
    inferDurationUnit(initialDraft.startsAt, initialDraft.endsAt),
  )
  const [showOptionalFields, setShowOptionalFields] = useState(
    Boolean(initialDraft.description || initialDraft.eventLocation),
  )
  const [submitting, setSubmitting] = useState(false)

  const dashboardLabel = activeDashboardName ?? 'the selected dashboard'
  const isRepeating = recurrenceMode !== 'none'
  const recurrenceIntervalNumber = Math.max(Number(recurrenceInterval) || 1, 1)
  const parsedStart = new Date(startsAt)
  const parsedEnd = new Date(endsAt)
  const hasValidStart = !Number.isNaN(parsedStart.getTime())
  const hasValidEnd = !Number.isNaN(parsedEnd.getTime())
  const scheduleError =
    !allDay && hasValidStart && hasValidEnd && parsedEnd <= parsedStart
      ? 'End time must be after the start time.'
      : null
  const durationMinutes = getDurationMinutes(startsAt, endsAt)
  const durationValue = formatDurationValue(durationMinutes, durationUnit)
  const overlapWarning = !isRepeating
    ? null
    : getRecurringOverlapWarning(
        startsAt,
        allDay ? getAllDayEndDateTime(startsAt) : endsAt,
        recurrenceMode,
        recurrenceInterval,
      )
  const recurrenceSummary = !isRepeating
    ? 'Does not repeat'
    : `Repeats every ${recurrenceIntervalNumber} ${repeatUnitLabel(
        recurrenceMode,
        recurrenceIntervalNumber,
      )}${recurrenceMode === 'weekly' ? ` on ${formatWeeklySelection(recurrenceWeekdays)}` : ''}${
        recurrenceEndsOn ? ` until ${formatEndDateLabel(recurrenceEndsOn)}` : ''
      }.`

  const syncSelectedCreateDate = useEffectEvent((nextSelectedDate: Date) => {
    const syncedDraft = syncCreateDraftToSelectedDate({
      selectedDate: nextSelectedDate,
      startsAt,
      endsAt,
      recurrenceMode,
      recurrenceWeekdays,
    })

    if (syncedDraft.startsAt !== startsAt) setStartsAt(syncedDraft.startsAt)
    if (syncedDraft.endsAt !== endsAt) setEndsAt(syncedDraft.endsAt)
    if (syncedDraft.recurrenceWeekdays !== recurrenceWeekdays)
      setRecurrenceWeekdays(syncedDraft.recurrenceWeekdays)
  })

  useEffect(() => {
    if (mode !== 'create' || !selectedDate) return
    syncSelectedCreateDate(selectedDate)
  }, [mode, selectedDate])

  function toggleRecurrenceWeekday(weekday: number) {
    setRecurrenceWeekdays((current) => {
      if (current.includes(weekday)) {
        if (current.length === 1) return current
        return current.filter((value) => value !== weekday)
      }
      return [...current, weekday]
    })
  }

  function ensureWeeklySelection(nextStartsAt: string) {
    if (recurrenceMode === 'weekly' && recurrenceWeekdays.length === 0) {
      setRecurrenceWeekdays([toMondayWeekday(new Date(nextStartsAt).getDay())])
    }
  }

  function handleStartsAtChange(value: string) {
    setStartsAt(value)
    ensureWeeklySelection(value)
    if (!allDay && durationMinutes != null && durationMinutes > 0) {
      const newEnd = new Date(value)
      if (!Number.isNaN(newEnd.getTime())) {
        newEnd.setMinutes(newEnd.getMinutes() + durationMinutes)
        setEndsAt(toLocalDateTimeValue(newEnd))
      }
    }
  }

  function handleRecurrenceModeChange(value: RecurrenceMode) {
    setRecurrenceMode(value)
    if (value !== 'none') setLastRecurringMode(value)
    if (value === 'weekly' && recurrenceWeekdays.length === 0) {
      setRecurrenceWeekdays([toMondayWeekday(new Date(startsAt).getDay())])
    }
  }

  function handleRepeatEnabledChange(enabled: boolean) {
    if (!enabled) {
      setRecurrenceMode('none')
      return
    }
    handleRecurrenceModeChange(recurrenceMode === 'none' ? lastRecurringMode : recurrenceMode)
  }

  function handleDurationValueChange(value: string) {
    if (!hasValidStart) return
    const nextValue = Number(value)
    if (!Number.isFinite(nextValue) || nextValue <= 0) return
    const nextEnd = new Date(parsedStart)
    nextEnd.setMinutes(nextEnd.getMinutes() + toDurationMinutes(nextValue, durationUnit))
    setEndsAt(toLocalDateTimeValue(nextEnd))
  }

  function adjustDuration(delta: number) {
    if (!hasValidStart) return
    const currentValue = Number(durationValue) || getMinimumDurationValue(durationUnit)
    const nextValue = Math.max(
      getMinimumDurationValue(durationUnit),
      currentValue + delta * getDurationStep(durationUnit),
    )
    const nextEnd = new Date(parsedStart)
    nextEnd.setMinutes(nextEnd.getMinutes() + toDurationMinutes(nextValue, durationUnit))
    setEndsAt(toLocalDateTimeValue(nextEnd))
  }

  function handleDurationUnitChange(nextUnit: DurationUnit) {
    setDurationUnit(nextUnit)
    if (!hasValidStart) return
    const nextEnd = new Date(parsedStart)
    nextEnd.setMinutes(
      nextEnd.getMinutes() + toDurationMinutes(getDefaultDurationValue(nextUnit), nextUnit),
    )
    setEndsAt(toLocalDateTimeValue(nextEnd))
  }

  function handleRecurrenceIntervalChange(value: string) {
    const nextValue = Number(value)
    if (!Number.isFinite(nextValue) || nextValue < 1) return
    setRecurrenceInterval(String(Math.floor(nextValue)))
  }

  function adjustRecurrenceInterval(delta: number) {
    const currentValue = Number(recurrenceInterval) || 1
    setRecurrenceInterval(String(Math.max(1, currentValue + delta)))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (scheduleError || submitting) return
    setSubmitting(true)
    try {
      await onSubmit({
        title,
        description,
        eventLocation,
        startsAt,
        endsAt: allDay ? getAllDayEndDateTime(startsAt) : endsAt,
        allDay,
        recurrenceMode,
        recurrenceInterval,
        recurrenceWeekdays,
        recurrenceEndsOn,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-busy={submitting}
      className="overflow-hidden rounded-t-2xl border border-zinc-800/80 bg-zinc-950 shadow-[0_-8px_40px_rgba(0,0,0,0.5)] sm:rounded-2xl sm:shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <p className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            {mode === 'edit' ? 'Edit event' : 'Add event'}
          </p>
          <p className="truncate text-xs text-zinc-500">{dashboardLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>

      {/* Body */}
      <div className="grid gap-3 px-4 pb-4">
        {/* Title */}
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:bg-zinc-900 focus:outline-none sm:h-10 sm:text-sm"
          placeholder="Event title"
          aria-label="Event title"
          required
        />

        {/* Optional details */}
        {showOptionalFields && (
          <div className="grid gap-2 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <label className="grid gap-1">
              <span className="px-0.5 text-xs text-zinc-500">Location</span>
              <input
                value={eventLocation}
                onChange={(event) => setEventLocation(event.target.value)}
                className={INPUT_CLASS}
                placeholder="Kitchen"
              />
            </label>
            <label className="grid gap-1">
              <span className="px-0.5 text-xs text-zinc-500">Notes</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                className="resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none"
                placeholder="Optional details"
              />
            </label>
          </div>
        )}

        {/* Timing section */}
        <div className="grid gap-2">
          {/* All-day toggle + date picker (all-day mode) */}
          <div className="flex items-center gap-2">
            <AllDayToggle allDay={allDay} onAllDayChange={setAllDay} />
            {allDay && (
              <input
                type="date"
                value={startsAt.slice(0, 10)}
                onChange={(event) => handleStartsAtChange(`${event.target.value}T00:00`)}
                aria-label="Date"
                className={cn(INPUT_CLASS, 'flex-1')}
                required
              />
            )}
          </div>

          {/* Start + end datetime — stacked on mobile, side-by-side on sm+ */}
          {!allDay && (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(event) => handleStartsAtChange(event.target.value)}
                aria-label="Start time"
                className={cn(INPUT_CLASS, 'w-full')}
                required
              />
              <span className="hidden select-none text-zinc-600 sm:block">–</span>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
                aria-invalid={Boolean(scheduleError)}
                aria-label="End time"
                className={cn(
                  INPUT_CLASS,
                  'w-full',
                  scheduleError && 'border-rose-500/40 focus:border-rose-400',
                )}
                required
              />
            </div>
          )}

          {/* Duration + repeat */}
          <div className="flex flex-wrap items-center gap-2">
            {!allDay && (
              <DurationControl
                durationUnit={durationUnit}
                durationValue={durationValue}
                disabled={Boolean(scheduleError)}
                onAdjustDuration={adjustDuration}
                onDurationUnitChange={handleDurationUnitChange}
                onDurationValueChange={handleDurationValueChange}
              />
            )}
            <select
              value={isRepeating ? 'repeating' : 'none'}
              onChange={(event) => handleRepeatEnabledChange(event.target.value === 'repeating')}
              aria-label="Repeat"
              className={INPUT_CLASS}
            >
              <option value="none">No repeat</option>
              <option value="repeating">Repeats</option>
            </select>
          </div>
        </div>

        {/* Repeat configuration */}
        {isRepeating && (
          <CalendarEditorRepeatSection
            recurrenceMode={recurrenceMode}
            recurrenceInterval={recurrenceInterval}
            recurrenceEndsOn={recurrenceEndsOn}
            recurrenceWeekdays={recurrenceWeekdays}
            recurrenceSummary={recurrenceSummary}
            onAdjustRecurrenceInterval={adjustRecurrenceInterval}
            onRecurrenceIntervalChange={handleRecurrenceIntervalChange}
            onRecurrenceModeChange={handleRecurrenceModeChange}
            onRecurrenceEndsOnChange={setRecurrenceEndsOn}
            onToggleRecurrenceWeekday={toggleRecurrenceWeekday}
          />
        )}

        {/* Error / overlap warning */}
        {(scheduleError || overlapWarning) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {scheduleError || overlapWarning}
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 border-t border-zinc-800/60 px-4 py-3">
        <button
          type="button"
          onClick={() => setShowOptionalFields((current) => !current)}
          className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200"
        >
          {showOptionalFields ? 'Hide details' : 'Details'}
        </button>
        <button
          type="submit"
          disabled={submitting || Boolean(scheduleError)}
          className="h-11 flex-1 rounded-xl bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 shadow-[0_2px_20px_rgba(255,255,255,0.08)] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 sm:h-10"
        >
          {submitting
            ? mode === 'edit'
              ? 'Saving...'
              : 'Creating...'
            : mode === 'edit'
              ? 'Save changes'
              : 'Create event'}
        </button>
      </div>
    </form>
  )
})

function DurationControl({
  disabled,
  durationUnit,
  durationValue,
  onAdjustDuration,
  onDurationValueChange,
  onDurationUnitChange,
}: {
  disabled: boolean
  durationUnit: DurationUnit
  durationValue: string
  onAdjustDuration: (delta: number) => void
  onDurationValueChange: (value: string) => void
  onDurationUnitChange: (unit: DurationUnit) => void
}) {
  return (
    <div className="flex h-9 w-fit items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-2">
      <div className="flex items-center rounded-md border border-zinc-800/60">
        <button
          type="button"
          onClick={() => onAdjustDuration(-1)}
          disabled={disabled}
          className="flex h-7 w-7 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700"
          aria-label="Decrease duration"
        >
          <Minus size={12} />
        </button>
        <input
          type="text"
          inputMode="decimal"
          value={durationValue}
          onChange={(event) => onDurationValueChange(event.target.value)}
          disabled={disabled}
          className="h-7 w-10 border-x border-zinc-800 bg-transparent px-1 text-center text-sm text-zinc-100 focus:outline-none disabled:text-zinc-600"
          aria-label="Duration value"
        />
        <button
          type="button"
          onClick={() => onAdjustDuration(1)}
          disabled={disabled}
          className="flex h-7 w-7 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700"
          aria-label="Increase duration"
        >
          <Plus size={12} />
        </button>
      </div>
      <select
        value={durationUnit}
        onChange={(event) => onDurationUnitChange(event.target.value as DurationUnit)}
        className="h-7 rounded-md border border-zinc-800/60 bg-zinc-950 px-1.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
        aria-label="Duration unit"
      >
        <option value="minutes">min</option>
        <option value="hours">hr</option>
        <option value="days">days</option>
      </select>
    </div>
  )
}

function AllDayToggle({
  allDay,
  onAllDayChange,
}: {
  allDay: boolean
  onAllDayChange: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex h-9 w-fit items-center gap-2 rounded-xl px-3 text-sm transition-colors',
        allDay
          ? 'border border-zinc-700 bg-zinc-900 text-zinc-100'
          : 'border border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
      )}
    >
      <input
        type="checkbox"
        checked={allDay}
        onChange={(event) => onAllDayChange(event.target.checked)}
        className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-zinc-100 focus:ring-0"
      />
      All day
    </label>
  )
}

function getAllDayEndDateTime(startsAt: string): string {
  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) return startsAt
  const end = new Date(start)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  return toLocalDateTimeValue(end)
}

const INPUT_CLASS =
  'h-9 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none'
