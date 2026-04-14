import { cn } from '../../utils/shared/cn'

export function CalendarDayNumber({
  value,
  isToday,
  isSelected = false,
  dimmed = false,
  compact = false,
}: {
  value: string
  isToday: boolean
  isSelected?: boolean
  dimmed?: boolean
  compact?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-medium transition-colors',
        compact ? 'min-w-4 px-1 py-0 text-[9px]' : 'min-w-5 px-1.5 py-0.5 text-[10px]',
        isToday
          ? cn(
              'bg-zinc-100 text-zinc-950',
              isSelected && 'ring-1 ring-sky-400/40 ring-offset-1 ring-offset-zinc-950',
            )
          : isSelected
            ? 'bg-sky-500/12 text-sky-200 ring-1 ring-sky-400/25'
            : dimmed
              ? 'text-zinc-600'
              : 'text-zinc-400',
      )}
    >
      {value}
    </span>
  )
}
