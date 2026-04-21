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
  startsAt,
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
  startsAt: string
  recurrenceSummary: string
  onAdjustRecurrenceInterval: (delta: number) => void
  onRecurrenceIntervalChange: (value: string) => void
  onRecurrenceModeChange: (value: RepeatCadenceMode) => void
  onRecurrenceEndsOnChange: (value: string) => void
  onToggleRecurrenceWeekday: (weekday: number) => void
}) {
  return (
    <div className="grid gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/25 p-2.5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,230px)_minmax(0,1fr)] xl:items-start">
      <div className="grid gap-1.5 text-sm">
        <span className="px-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">Every</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950">
            <button
              type="button"
              onClick={() => onAdjustRecurrenceInterval(-1)}
              className="flex h-8 w-8 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
              aria-label="Decrease repeat interval"
            >
              <Minus size={14} />
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={recurrenceInterval}
              onChange={(event) => onRecurrenceIntervalChange(event.target.value)}
              className="h-8 w-10 border-x border-zinc-800 bg-transparent px-1 text-center text-sm text-zinc-100 focus:outline-none"
              aria-label="Repeat interval"
            />
            <button
              type="button"
              onClick={() => onAdjustRecurrenceInterval(1)}
              className="flex h-8 w-8 items-center justify-center text-zinc-400 transition-colors hover:text-zinc-100"
              aria-label="Increase repeat interval"
            >
              <Plus size={14} />
            </button>
          </div>
          <select
            value={recurrenceMode}
            onChange={(event) => onRecurrenceModeChange(event.target.value as RepeatCadenceMode)}
            className="h-8 min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
            aria-label="Repeat cadence"
          >
            {REPEAT_CADENCE_OPTIONS.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-1.5 text-sm">
        <span className="px-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">Ends</span>
        <label className="flex min-w-0 items-center rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
          <input
            type="date"
            value={recurrenceEndsOn}
            min={startsAt.slice(0, 10)}
            onChange={(event) => onRecurrenceEndsOnChange(event.target.value)}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 focus:outline-none"
          />
        </label>
      </div>
      {recurrenceMode === 'weekly' && (
        <div className="grid gap-1.5 text-sm">
          <span className="px-1 text-[11px] uppercase tracking-[0.16em] text-zinc-500">Days</span>
          <div className="flex flex-wrap gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5">
            {WEEKDAY_PICKER_OPTIONS.map((option) => {
              const selected = recurrenceWeekdays.includes(option.value)
              return (
                <button
                  key={`${option.name}-${option.value}`}
                  type="button"
                  onClick={() => onToggleRecurrenceWeekday(option.value)}
                  className={cn(
                    'inline-flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
                    selected
                      ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                      : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                  )}
                  aria-pressed={selected}
                  title={option.name}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {recurrenceMode !== 'weekly' && (
        <p className="hidden xl:block text-right text-xs text-zinc-500">{recurrenceSummary}</p>
      )}
      {recurrenceMode === 'weekly' && (
        <p className="xl:col-span-3 text-xs text-zinc-500">{recurrenceSummary}</p>
      )}
    </div>
  )
})
