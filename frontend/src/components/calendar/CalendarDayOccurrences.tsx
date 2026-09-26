import type { ReactNode, Ref } from 'react'
import type { CalendarOccurrence } from '../../api/calendar'
import {
  calendarOccurrenceCellPrefix,
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

/** The tint a pill takes from what it stands for: a series, or a one-off. */
export function occurrenceTint(occurrence: CalendarOccurrence): string {
  return occurrence.recurring ? 'bg-emerald-500/12 text-emerald-300' : 'bg-sky-500/12 text-sky-300'
}

/** The same distinction as a solid dot, for a cell too narrow for the pill. */
export function occurrenceDot(occurrence: CalendarOccurrence): string {
  return occurrence.recurring ? 'bg-emerald-300' : 'bg-sky-300'
}

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
 * `height` is measured by the caller rather than here, because every grid using this gives its
 * cells one shared height — so one observer on the first cell answers for the whole grid, and
 * `measureRef` is what that cell passes down. Width the body answers for itself: below 80px a
 * pill gives up its time and its dots for the title, and cuts that with a fade, not an ellipsis.
 */
export function CalendarDayOccurrences({
  heading,
  occurrences,
  day,
  height,
  density,
  measureRef,
}: {
  heading: ReactNode
  occurrences: CalendarOccurrence[]
  day: Date
  height: number
  density: CalendarDayDensity
  measureRef?: Ref<HTMLDivElement>
}) {
  const { rowHeight, pill } = DENSITY[density]
  const { visible, hidden } = fitOccurrenceRows(height, rowHeight, occurrences.length)

  return (
    <>
      <div className="mb-1 flex min-w-0 shrink-0 items-center justify-between gap-0.5">
        {heading}
        {hidden > 0 && (
          // `leading-none`, or it outgrows the compact date and busy cells get less body than
          // the cell every other one is measured by.
          <span
            className="shrink-0 text-[9px] leading-none text-zinc-400"
            title={hiddenOccurrencesTitle(occurrences.slice(visible), day)}
          >
            +{hidden}
          </span>
        )}
      </div>
      <div ref={measureRef} className="@container flex-1 min-h-0 overflow-hidden space-y-0.5">
        {occurrences.slice(0, visible).map((occurrence) => {
          const prefix = calendarOccurrenceCellPrefix(occurrence, day, 'compact')
          return (
            <div
              key={`${occurrence.event_id}:${occurrence.original_start}`}
              title={formatCalendarOccurrenceCellTitle(occurrence, day)}
              className={cn(
                'flex items-center gap-1 rounded text-[10px] @max-[80px]:px-0.5',
                pill,
                occurrenceTint(occurrence),
              )}
            >
              <ParticipantMicroDots
                participants={occurrence.participants}
                className="@max-[80px]:hidden"
              />
              <span className="min-w-0 flex-1 truncate @max-[80px]:text-clip @max-[80px]:fade-end">
                {prefix && <span className="@max-[80px]:hidden">{prefix} </span>}
                {occurrence.title}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
