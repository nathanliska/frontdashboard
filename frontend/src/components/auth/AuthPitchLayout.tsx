import type { ReactNode } from 'react'
import {
  CALENDAR_WEEKDAY_LABELS,
  CALENDAR_WEEKDAY_LABELS_COMPACT,
} from '../../utils/calendar/calendarUtils'

// A drawn week, not this week: the board is a depiction throughout, like a screenshot, and the
// clock beside it is fixed too. Both name the day through the label array rather than a column
// number, so changing which day the week starts on moves the mark and the clock together.
const DRAWN_WEEK = [14, 15, 16, 17, 18, 19, 20]
const DRAWN_WEEKDAY = { short: 'Sat', long: 'Saturday' } as const

function Tile({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-3 ${className ?? ''}`.trim()}>
      {children}
    </div>
  )
}

function ListItem({ label, done = false }: { label: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`size-3.5 shrink-0 rounded-sm ${done ? 'bg-zinc-600' : 'border border-zinc-600'}`}
      />
      <span className={`text-xs ${done ? 'text-zinc-400 line-through' : 'text-zinc-200'}`}>
        {label}
      </span>
    </div>
  )
}

/**
 * A drawing of a dashboard, built from markup rather than an image.
 *
 * This is the eagerly loaded public route, so a screenshot would be bytes every visitor pays for.
 * It shows the four widget types that exist, and takes the week's shape from the calendar's own
 * labels so the front door cannot promise a week that starts on a different day than the app.
 */
function BoardDrawing() {
  return (
    <div
      aria-hidden="true"
      className="grid max-w-140 grid-cols-1 gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950 p-3 sm:auto-rows-32 sm:grid-cols-3"
    >
      <Tile className="flex flex-col justify-center gap-2.5 sm:col-span-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-200">Groceries</span>
          <span className="text-[11px] text-zinc-400">1 left</span>
        </div>
        <ListItem label="Oat milk" done />
        <ListItem label="Bread" done />
        <ListItem label="Coffee" />
      </Tile>

      <Tile className="flex flex-col items-center justify-center gap-0.5">
        <span className="text-3xl font-semibold tracking-tight text-zinc-100">07:24</span>
        <span className="text-[11px] text-zinc-400">{DRAWN_WEEKDAY.long}</span>
      </Tile>

      <Tile className="flex flex-col justify-center gap-2">
        <div className="grid grid-cols-7 gap-x-0.5 text-center text-[10px] text-zinc-400">
          {/* Keyed by the long label because the initials repeat — two S and two T collide. */}
          {CALENDAR_WEEKDAY_LABELS.map((day, i) => (
            <span key={day}>{CALENDAR_WEEKDAY_LABELS_COMPACT[i]}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-x-0.5 text-center text-[11px] text-zinc-300">
          {DRAWN_WEEK.map((date, i) => (
            <span
              key={date}
              className={
                i === CALENDAR_WEEKDAY_LABELS.indexOf(DRAWN_WEEKDAY.short)
                  ? 'rounded-sm bg-blue-600 font-semibold text-white'
                  : undefined
              }
            >
              {date}
            </span>
          ))}
        </div>
      </Tile>

      <Tile className="flex flex-col justify-center gap-2 sm:col-span-2">
        <span className="text-xs font-semibold text-zinc-200">Today</span>
        <div className="flex gap-2.5 text-xs">
          <span className="w-11 shrink-0 text-zinc-400">09:00</span>
          <span className="text-zinc-300">Swim lesson</span>
        </div>
        <div className="flex gap-2.5 text-xs">
          <span className="w-11 shrink-0 text-zinc-400">18:30</span>
          <span className="text-zinc-300">Bins out</span>
        </div>
      </Tile>
    </div>
  )
}

/**
 * What this is, for a visitor who arrived cold — registration is open, so the sign-in page is the
 * front door and a name over two fields tells them nothing.
 *
 * Rendered after the form in the DOM on purpose: below `lg` it reads underneath, and above it the
 * flex order moves it left without moving it ahead of the form for Tab or a screen reader.
 */
function AuthPitchPanel() {
  return (
    <section className="flex flex-col justify-center gap-8 bg-zinc-900/40 px-6 py-10 lg:order-1 lg:min-h-screen lg:grow lg:px-10 lg:py-20 xl:px-20">
      <div className="flex max-w-140 flex-col gap-4">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-50 text-balance lg:text-[2.375rem]/[1.15]">
          A shared home screen for your household.
        </h2>
        <p className="text-sm text-zinc-400 lg:text-base/relaxed">
          Lists, a calendar and the things worth a glance, on one page that everyone in the house
          can see — and that catches up on every screen as they change.
        </p>
      </div>

      <BoardDrawing />

      <div className="flex max-w-140 flex-col gap-2 text-[13px] text-zinc-400">
        <p>
          Lists, an agenda, a calendar and a clock, dragged into whatever arrangement suits the
          room. Share a dashboard and its lists and events go with it.
        </p>
        <p>Open source. Sign up with any email address.</p>
      </div>
    </section>
  )
}

/**
 * The two-column frame the sign-in and register pages share: form on the right, pitch on the left.
 *
 * Both halves live here so the breakpoint cannot drift apart — the row and the two `order` classes
 * have to flip at the same width or the panel lands above the form, or beside it on the wrong side.
 */
export function AuthPitchLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 lg:flex-row lg:items-start">
      <div className="flex w-full flex-col justify-center px-6 py-10 lg:order-2 lg:min-h-screen lg:w-120 lg:shrink-0 lg:px-16">
        <div className="mx-auto w-full max-w-sm">{children}</div>
      </div>
      <AuthPitchPanel />
    </div>
  )
}
