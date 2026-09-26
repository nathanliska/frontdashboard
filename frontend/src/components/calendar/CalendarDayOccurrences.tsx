import type { ReactNode, Ref } from 'react'
import type { CalendarOccurrence } from '../../api/calendar'
import {
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
} from '../../utils/calendar/calendarUtils'
import { cn } from '../../utils/shared/cn'
import { ParticipantMicroDots } from './ParticipantDots'

/** Mirrors `space-y-0.5` on the stack below. */
const ROW_GAP = 2

/**
 * Row pitch of a pill, beside the padding that produces it — change one and the other is in view.
 * Rounded up, so a rounding error costs a row rather than clipping one.
 */
const DENSITY = {
  week: { rowHeight: 21, pill: 'px-1.5 py-1 leading-tight' },
  month: { rowHeight: 16, pill: 'px-1 leading-4' },
} as const

export type CalendarDayDensity = keyof typeof DENSITY

export const MONTH_PILL_HEIGHT = DENSITY.month.rowHeight

/** Mirrors `mb-1` under the heading line below. */
export const DAY_HEADING_GAP = 4

/** Below this body width a time prefix leaves no room for the title, so the title goes alone. */
const TITLE_ONLY_WIDTH = 80

/**
 * How many of `total` occurrences a cell body `height` pixels tall shows, and how many it hides.
 *
 * The "+N" sits on the heading line rather than in a row of its own, so every row that fits holds
 * an event. At least one row always shows, so a busy day in a short cell still names something.
 */
export function fitOccurrenceRows(
  height: number,
  rowHeight: number,
  total: number,
): { visible: number; hidden: number } {
  const rows = Math.max(1, Math.floor((height + ROW_GAP) / (rowHeight + ROW_GAP)))
  const visible = Math.min(total, rows)
  return { visible, hidden: total - visible }
}

/**
 * Hover text for a "+N": what the rows it stands in for would have said.
 *
 * The day link opens the full list; the tooltip also supports a quick pointer preview.
 */
export function hiddenOccurrencesTitle(hidden: CalendarOccurrence[], day: Date): string {
  return hidden
    .map((occurrence) => formatCalendarOccurrenceCellLabel(occurrence, day, 'compact'))
    .join('\n')
}

/**
 * A calendar day cell's heading line and body: as many occurrence pills as fit, "+N" for the rest.
 *
 * `height` and `width` are measured by the caller rather than here, because every grid using this
 * gives its cells one shared size — so one observer on the first cell answers for the whole grid,
 * and `measureRef` is what that cell passes down.
 */
export function CalendarDayOccurrences({
  heading,
  occurrences,
  day,
  height,
  width = Number.POSITIVE_INFINITY,
  density,
  titleOnly = false,
  measureRef,
}: {
  heading: ReactNode
  occurrences: CalendarOccurrence[]
  day: Date
  height: number
  width?: number
  density: CalendarDayDensity
  titleOnly?: boolean
  measureRef?: Ref<HTMLDivElement>
}) {
  const { rowHeight, pill } = DENSITY[density]
  const { visible, hidden } = fitOccurrenceRows(height, rowHeight, occurrences.length)
  // Zero is the caller's size before its first measurement, not a narrow cell.
  const narrow = width > 0 && width < TITLE_ONLY_WIDTH

  return (
    <>
      <div className="mb-1 flex min-w-0 shrink-0 items-center justify-between gap-0.5">
        {heading}
        {hidden > 0 && (
          // `leading-none`, or it outgrows the compact date and busy cells get less body than
          // the cell every other one is measured by.
          <span
            className="shrink-0 text-[9px] leading-none text-zinc-500"
            title={hiddenOccurrencesTitle(occurrences.slice(visible), day)}
          >
            +{hidden}
          </span>
        )}
      </div>
      <div ref={measureRef} className="flex-1 min-h-0 overflow-hidden space-y-0.5">
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
            {!narrow && <ParticipantMicroDots participants={occurrence.participants} />}
            <span className="min-w-0 truncate">
              {titleOnly || narrow
                ? occurrence.title
                : formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
