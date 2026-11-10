/**
 * A day cell's border and fill: every day is the same quiet tile, so its events stand out,
 * and today gets a bright top edge. One set per state, since `cn` only joins and two would race.
 */
export function dayCellTone({
  isToday,
  isSelected = false,
}: {
  isToday: boolean
  isSelected?: boolean
}): string {
  const edge = isToday ? ' shadow-[inset_0_2px_0_var(--color-zinc-200)]' : ''
  if (isSelected) return `border-sky-500/40 bg-sky-500/6${edge}`
  if (isToday) return `border-zinc-600 bg-zinc-900${edge}`
  return 'border-transparent bg-zinc-950/40'
}
