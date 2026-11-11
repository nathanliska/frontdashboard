import { cn } from '../../utils/shared/cn'

/** The badge's rendered height, for a caller deciding what fits under it. */
export const DAY_NUMBER_HEIGHT = 9

export function CalendarDayNumber({
  value,
  isToday,
  isSelected = false,
  dimmed = false,
  className,
}: {
  value: string
  isToday: boolean
  isSelected?: boolean
  dimmed?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-medium transition-colors',
        'min-w-3.5 px-0.5 py-0 text-[9px] leading-none',
        // No ring when selected: the cell's border shows that, and a ring would crowd its corner.
        isToday
          ? 'bg-zinc-100 text-zinc-950'
          : isSelected
            ? 'bg-sky-500/12 text-sky-200'
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
