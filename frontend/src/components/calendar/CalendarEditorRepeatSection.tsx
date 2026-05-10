import { Minus, Plus } from 'lucide-react'
import { memo } from 'react'
import {
  type RecurrenceMode,
  WEEKDAY_PICKER_OPTIONS,
} from '../../utils/calendar/calendarEditorDraftUtils'
import { cn } from '../../utils/shared/cn'

type RepeatCadenceMode = Exclude<RecurrenceMode, 'none'>

const REPEAT_CADENCE_OPTIONS: ReadonlyArray<{
  mode: RepeatCadenceMode
  label: string
}> = [
  { mode: 'daily', label: 'Day' },
  { mode: 'weekly', label: 'Week' },
  { mode: 'monthly', label: 'Month' },
  { mode: 'yearly', label: 'Year' },
]

export const CalendarEditorRepeatSection = memo(function CalendarEditorRepeatSection({
  recurrenceMode,
  recurrenceInterval,
  recurrenceEndsOn,
  recurrenceWeekdays,
  recurrenceSummary,
  onAdjustRecurrenceInterval,
  onRecurrenceIntervalChange,
  onRecurrenceModeChange,
  onRecurrenceEndsOnChange,
  onToggleRecurrenceWeekday,
}: {
  recurrenceMode: RepeatCadenceMode
  recurrenceInterval: string
  recurrenceEndsOn: string
  recurrenceWeekdays: number[]
  recurrenceSummary: string
  onAdjustRecurrenceInterval: (delta: number) => void
  onRecurrenceIntervalChange: (value: string) => void
  onRecurrenceModeChange: (value: RepeatCadenceMode) => void
  onRecurrenceEndsOnChange: (value: string) => void
  onToggleRecurrenceWeekday: (weekday: number) => void
}) {
  return (
    <div className="grid gap-1.5">
      {/* Every N [cadence] + weekday picker */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-2.5">
          <span className="text-xs text-zinc-500">Every</span>
          <div className="flex items-center rounded-md border border-zinc-800/60">
            <button
              type="button"
              onClick={() => onAdjustRecurrenceInterval(-1)}
              className="flex h-7 w-6 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
              aria-label="Decrease repeat interval"
            >
              <Minus size={11} />
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={recurrenceInterval}
              onChange={(event) => onRecurrenceIntervalChange(event.target.value)}
              className="h-7 w-8 border-x border-zinc-800 bg-transparent text-center text-sm text-zinc-100 focus:outline-none"
              aria-label="Repeat interval"
            />
            <button
              type="button"
              onClick={() => onAdjustRecurrenceInterval(1)}
              className="flex h-7 w-6 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
              aria-label="Increase repeat interval"
            >
              <Plus size={11} />
            </button>
          </div>
          <select
            value={recurrenceMode}
            onChange={(event) => onRecurrenceModeChange(event.target.value as RepeatCadenceMode)}
            className="h-7 rounded-md border border-zinc-800/60 bg-zinc-950 px-1.5 text-sm text-zinc-100 focus:outline-none"
            aria-label="Repeat cadence"
          >
            {REPEAT_CADENCE_OPTIONS.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* Weekday picker — weekly only */}
        {recurrenceMode === 'weekly' && (
          <div className="flex h-9 items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950 px-2">
            {WEEKDAY_PICKER_OPTIONS.map((option) => {
              const selected = recurrenceWeekdays.includes(option.value)
              return (
                <button
                  key={`${option.name}-${option.value}`}
                  type="button"
                  onClick={() => onToggleRecurrenceWeekday(option.value)}
                  aria-pressed={selected}
                  title={option.name}
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold transition-colors',
                    selected ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-200',
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Until — always on its own row so the date input never overflows */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-zinc-500">until</span>
        <input
          type="date"
          value={recurrenceEndsOn}
          onChange={(event) => onRecurrenceEndsOnChange(event.target.value)}
          aria-label="Recurrence end date"
          className="h-9 min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 focus:border-zinc-700 focus:outline-none"
        />
      </div>

      <p className="px-0.5 text-xs text-zinc-500">{recurrenceSummary}</p>
    </div>
  )
})
