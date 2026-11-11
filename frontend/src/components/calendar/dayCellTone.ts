/**
 * A day cell's border and fill: every day is the same quiet tile, so its events stand out, and
 * today's badge marks it. One set per state, since `cn` only joins and two would race.
 */
export function dayCellTone({
  isToday,
  isSelected = false,
}: {
  isToday: boolean
  isSelected?: boolean
}): string {
  if (isSelected) return 'border-sky-500/40 bg-sky-500/6'
  if (isToday) return 'border-zinc-600 bg-zinc-900'
  return 'border-transparent bg-zinc-950/40'
}
