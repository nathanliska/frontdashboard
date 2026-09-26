import { cn } from '../../utils/shared/cn'

/** Rendered height of each badge size below, for a caller deciding what fits under it. */
export const DAY_NUMBER_HEIGHT = { full: 19, compact: 9 } as const

/**
 * Narrowest cell body that fits the full badge beside a "+N": a two-digit date is ~23px, and a
 * two-digit "+NN" with its gap ~17px.
 */
export const FULL_DAY_NUMBER_MIN_WIDTH = 40

export function CalendarDayNumber({
  value,
  isToday,
  isSelected = false,
  dimmed = false,
  compact = false,
  className,
}: {
  value: string
  isToday: boolean
  isSelected?: boolean
  dimmed?: boolean
  compact?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-medium transition-colors',
        compact
          ? 'min-w-3.5 px-0.5 py-0 text-[9px] leading-none'
          : 'min-w-5 px-1.5 py-0.5 text-[10px] leading-[15px]',
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
        className,
      )}
    >
      {value}
    </span>
  )
}
