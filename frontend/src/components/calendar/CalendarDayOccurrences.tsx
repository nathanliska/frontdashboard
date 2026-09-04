import type { RefCallback } from 'react'
import type { CalendarOccurrence } from '../../api/calendar'
import {
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
} from '../../utils/calendar/calendarUtils'
import { cn } from '../../utils/shared/cn'
import { ParticipantMicroDots } from './ParticipantDots'

/** Mirrors `space-y-1` on the stack below. */
const ROW_GAP = 4

/**
 * Row pitch of a pill, beside the padding that produces it — change one and the other is in view.
 * Rounded up, so a rounding error costs a row rather than clipping one.
 */
const DENSITY = {
  week: { rowHeight: 21, pill: 'px-1.5 py-1 leading-tight' },
  month: { rowHeight: 19, pill: 'px-1 py-0.5' },
} as const

export type CalendarDayDensity = keyof typeof DENSITY

/**
 * How many of `total` occurrences a cell body `height` pixels tall shows, and how many it hides.
 *
 * The "+N" line spends a row of its own, so a cell that cannot show everything shows one fewer
 * event than it has room for — never a full cell with an event silently missing from it.
 */
export function fitOccurrenceRows(
  height: number,
  rowHeight: number,
  total: number,
): { visible: number; hidden: number } {
  const rows = Math.max(1, Math.floor((height + ROW_GAP) / (rowHeight + ROW_GAP)))
  const visible = total <= rows ? total : rows - 1
  return { visible, hidden: total - visible }
}

/**
 * Hover text for a "+N" line: what the rows it stands in for would have said.
 *
 * The month grids are the one surface with no way to reach a hidden occurrence — a widget cell is
 * not clickable at all — so the count needs to name them somewhere.
 */
function hiddenOccurrencesTitle(hidden: CalendarOccurrence[], day: Date): string {
  return hidden
    .map((occurrence) => formatCalendarOccurrenceCellLabel(occurrence, day, 'compact'))
    .join('\n')
}

/**
 * The body of a calendar day cell: as many occurrence pills as fit, then "+N" for the rest.
 *
 * `height` is measured by the caller rather than here, because every grid using this gives its
 * cells one shared height — so one observer on the first cell answers for the whole row, and
 * `measureRef` is what that cell passes down.
 */
export function CalendarDayOccurrences({
  occurrences,
  day,
  height,
  density,
  titleOnly = false,
  measureRef,
}: {
  occurrences: CalendarOccurrence[]
  day: Date
  height: number
  density: CalendarDayDensity
  titleOnly?: boolean
  measureRef?: RefCallback<HTMLDivElement> | null
}) {
  const { rowHeight, pill } = DENSITY[density]
  const { visible, hidden } = fitOccurrenceRows(height, rowHeight, occurrences.length)

  return (
    <div ref={measureRef} className="flex-1 min-h-0 overflow-hidden space-y-1">
      {occurrences.slice(0, visible).map((occurrence) => (
        <div
          key={`${occurrence.event_id}:${occurrence.original_start}`}
          title={formatCalendarOccurrenceCellTitle(occurrence, day)}
          className={cn(
            'flex items-center gap-1 rounded text-[10px]',
            pill,
            occurrence.recurring
              ? 'bg-emerald-500/12 text-emerald-300'
              : 'bg-sky-500/12 text-sky-300',
          )}
        >
          <ParticipantMicroDots participants={occurrence.participants} />
          <span className="min-w-0 truncate">
            {titleOnly
              ? occurrence.title
              : formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
          </span>
        </div>
      ))}
      {hidden > 0 && (
        <p
          className="text-[10px] text-zinc-500"
          title={hiddenOccurrencesTitle(occurrences.slice(visible), day)}
        >
          +{hidden}
        </p>
      )}
    </div>
  )
}
