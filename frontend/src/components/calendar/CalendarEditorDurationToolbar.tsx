import { Minus, Plus } from 'lucide-react'
import { memo } from 'react'
import type { DurationUnit } from '../../utils/calendar/calendarEditorDurationUtils'
import { cn } from '../../utils/shared/cn'

export const CalendarEditorDurationToolbar = memo(function CalendarEditorDurationToolbar({
  allDay,
  durationSummary,
  scheduleError,
  durationUnit,
  durationValue,
  onAllDayChange,
  onAdjustDuration,
  onDurationValueChange,
  onDurationUnitChange,
}: {
  allDay: boolean
  durationSummary: string | null
  scheduleError: string | null
  durationUnit: DurationUnit
  durationValue: string
  onAllDayChange: (checked: boolean) => void
  onAdjustDuration: (delta: number) => void
  onDurationValueChange: (value: string) => void
  onDurationUnitChange: (unit: DurationUnit) => void
}) {
  const hasScheduleError = Boolean(scheduleError)

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/25 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            'flex h-10 items-center gap-2 rounded-xl px-3 text-sm transition-colors',
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

        <div className="flex items-center gap-2 rounded-xl bg-zinc-950/70 px-2 py-1.5">
          <span className="pl-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
            Duration
          </span>
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950">
            <button
              type="button"
              onClick={() => onAdjustDuration(-1)}
              disabled={hasScheduleError}
              className="flex h-9 w-9 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700"
              aria-label="Decrease duration"
            >
              <Minus size={14} />
            </button>
            <input
              type="text"
              inputMode="decimal"
              value={durationValue}
              onChange={(event) => onDurationValueChange(event.target.value)}
              disabled={hasScheduleError}
              className="h-9 w-12 border-x border-zinc-800 bg-transparent px-1 text-center text-sm text-zinc-100 focus:outline-none disabled:text-zinc-600"
              aria-label="Duration value"
            />
            <button
              type="button"
              onClick={() => onAdjustDuration(1)}
              disabled={hasScheduleError}
              className="flex h-9 w-9 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700"
              aria-label="Increase duration"
            >
              <Plus size={14} />
            </button>
          </div>
          <select
            value={durationUnit}
            onChange={(event) => onDurationUnitChange(event.target.value as DurationUnit)}
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
            aria-label="Duration unit"
          >
            <option value="minutes">min</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </div>

      {!hasScheduleError && durationSummary && (
        <span className="text-xs text-zinc-500">{durationSummary}</span>
      )}
    </div>
  )
})
