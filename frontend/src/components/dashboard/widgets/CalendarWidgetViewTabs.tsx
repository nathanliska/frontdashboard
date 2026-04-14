import { memo } from 'react'
import { capitalize, cn } from '../../../utils/shared/cn'

export type CalendarWidgetView = 'day' | 'week' | 'month'

export const WidgetViewTabs = memo(function WidgetViewTabs({
  compact,
  showLabel = true,
  value,
  onChange,
}: {
  compact: boolean
  showLabel?: boolean
  value: CalendarWidgetView
  onChange: (value: CalendarWidgetView) => void | Promise<void>
}) {
  return (
    <div className="shrink-0 flex items-center justify-between gap-2">
      {showLabel ? (
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">View</p>
      ) : (
        <div />
      )}
      <ViewTabButtons compact={compact} value={value} onChange={onChange} />
    </div>
  )
})

export const ViewTabButtons = memo(function ViewTabButtons({
  compact,
  value,
  onChange,
}: {
  compact: boolean
  value: CalendarWidgetView
  onChange: (value: CalendarWidgetView) => void | Promise<void>
}) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
      {(['day', 'week', 'month'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => void onChange(option)}
          className={cn(
            'rounded-md px-2 py-1 text-[10px] font-medium transition-colors',
            value === option ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200',
          )}
          aria-pressed={value === option}
        >
          {compact ? option[0].toUpperCase() : capitalize(option)}
        </button>
      ))}
    </div>
  )
})
