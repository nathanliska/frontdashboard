import { memo, useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import { CalendarEditorDurationToolbar } from './CalendarEditorDurationToolbar'
import { CalendarEditorRepeatSection } from './CalendarEditorRepeatSection'
import { cn } from '../../utils/shared/cn'
import {
  type CalendarEditorDraft,
  type EditorMode,
  type RecurrenceMode,
  formatEndDateLabel,
  formatWeeklySelection,
  getDurationSummary,
  getRecurringOverlapWarning,
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
    Boolean(initialDraft.description || initialDraft.eventLocation || mode === 'edit'),
  )
  const [submitting, setSubmitting] = useState(false)

  const dashboardLabel = activeDashboardName ?? 'the selected dashboard'
  const durationSummary = getDurationSummary(startsAt, endsAt)
  const isRepeating = recurrenceMode !== 'none'
  const recurrenceIntervalNumber = Math.max(Number(recurrenceInterval) || 1, 1)
  const parsedStart = new Date(startsAt)
  const parsedEnd = new Date(endsAt)
  const hasValidStart = !Number.isNaN(parsedStart.getTime())
  const hasValidEnd = !Number.isNaN(parsedEnd.getTime())
  const scheduleError =
    hasValidStart && hasValidEnd && parsedEnd <= parsedStart
      ? 'End time must be after the start time.'
      : null
  const durationMinutes = getDurationMinutes(startsAt, endsAt)
  const durationValue = formatDurationValue(durationMinutes, durationUnit)
  const overlapWarning = !isRepeating
    ? null
    : getRecurringOverlapWarning(startsAt, endsAt, recurrenceMode, recurrenceInterval)
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

    if (syncedDraft.startsAt !== startsAt) {
      setStartsAt(syncedDraft.startsAt)
    }

    if (syncedDraft.endsAt !== endsAt) {
      setEndsAt(syncedDraft.endsAt)
    }

    if (syncedDraft.recurrenceWeekdays !== recurrenceWeekdays) {
      setRecurrenceWeekdays(syncedDraft.recurrenceWeekdays)
    }
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
  }

  function handleRecurrenceModeChange(value: RecurrenceMode) {
    setRecurrenceMode(value)
    if (value !== 'none') {
      setLastRecurringMode(value)
    }
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
    const nextValue = Math.max(1, currentValue + delta)
    setRecurrenceInterval(String(nextValue))
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
        endsAt,
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
      className="rounded-2xl border border-zinc-800/80 bg-gradient-to-br from-zinc-950/85 via-zinc-950/70 to-zinc-900/35 p-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.2)]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <p className="rounded-full border border-zinc-800 bg-zinc-950/80 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
            {mode === 'edit' ? 'Edit event' : 'Add event'}
          </p>
          <p className="truncate text-xs text-zinc-500">{dashboardLabel}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-900/50 hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>

      <div className="mt-2 grid gap-2.5">
        <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:items-end">
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-500">Title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={TITLE_CLASS_NAME}
              placeholder="Event title"
              required
            />
          </label>
          <div className="flex items-center gap-2 xl:pb-px">
            <button
              type="button"
              onClick={() => setShowOptionalFields((current) => !current)}
              className="h-11 rounded-xl border border-zinc-800 bg-zinc-900/35 px-3 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900/55 hover:text-zinc-200"
            >
              {showOptionalFields ? 'Hide details' : 'Details'}
            </button>
            <button
              type="submit"
              disabled={submitting || Boolean(scheduleError)}
              className="h-11 rounded-2xl bg-zinc-100 px-4 text-sm font-medium text-zinc-950 shadow-[0_10px_24px_rgba(255,255,255,0.06)] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {submitting
                ? mode === 'edit'
                  ? 'Saving...'
                  : 'Creating...'
                : mode === 'edit'
                  ? 'Save changes'
                  : 'Create'}
            </button>
          </div>
        </div>

        {showOptionalFields && (
          <div className="grid gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/25 p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <label className="grid gap-1 text-sm">
              <span className="text-zinc-400">Location</span>
              <input
                value={eventLocation}
                onChange={(event) => setEventLocation(event.target.value)}
                className={CONTROL_CLASS_NAME}
                placeholder="Kitchen"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-zinc-400">Notes</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                className={`${TEXTAREA_CLASS_NAME} resize-y`}
                placeholder="Optional details"
              />
            </label>
          </div>
        )}

        <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-500">Starts</span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => handleStartsAtChange(event.target.value)}
              className={CONTROL_CLASS_NAME}
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-500">Ends</span>
            <input
              type="datetime-local"
              value={endsAt}
              min={startsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              aria-invalid={Boolean(scheduleError)}
              className={cn(
                CONTROL_CLASS_NAME,
                scheduleError && 'border-rose-500/40 focus:border-rose-400',
              )}
              required
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-zinc-500">Repeat</span>
            <select
              value={isRepeating ? 'repeating' : 'none'}
              onChange={(event) => handleRepeatEnabledChange(event.target.value === 'repeating')}
              className={CONTROL_CLASS_NAME}
            >
              <option value="none">Does not repeat</option>
              <option value="repeating">Repeats</option>
            </select>
          </label>
        </div>

        {isRepeating && (
          <CalendarEditorRepeatSection
            recurrenceMode={recurrenceMode}
            recurrenceInterval={recurrenceInterval}
            recurrenceEndsOn={recurrenceEndsOn}
            recurrenceWeekdays={recurrenceWeekdays}
            startsAt={startsAt}
            recurrenceSummary={recurrenceSummary}
            onAdjustRecurrenceInterval={adjustRecurrenceInterval}
            onRecurrenceIntervalChange={handleRecurrenceIntervalChange}
            onRecurrenceModeChange={handleRecurrenceModeChange}
            onRecurrenceEndsOnChange={setRecurrenceEndsOn}
            onToggleRecurrenceWeekday={toggleRecurrenceWeekday}
          />
        )}

        <CalendarEditorDurationToolbar
          allDay={allDay}
          durationSummary={durationSummary}
          scheduleError={scheduleError}
          durationUnit={durationUnit}
          durationValue={durationValue}
          onAllDayChange={setAllDay}
          onAdjustDuration={adjustDuration}
          onDurationUnitChange={handleDurationUnitChange}
          onDurationValueChange={handleDurationValueChange}
        />

        {(scheduleError || overlapWarning) && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {scheduleError || overlapWarning}
          </div>
        )}
      </div>
    </form>
  )
})

const TITLE_CLASS_NAME =
  'h-12 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700'

const CONTROL_CLASS_NAME =
  'h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700'

const TEXTAREA_CLASS_NAME =
  'rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700'
