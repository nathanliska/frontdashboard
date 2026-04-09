import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  MapPin,
  Pencil,
  Plus,
  Repeat2,
  Trash2,
} from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { type CalendarOccurrence } from '../api/calendar'
import { useInitialDashboardSelection } from '../hooks/useInitialDashboardSelection'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  updateCalendarEvent,
  useCalendarOccurrences,
} from '../resources/calendarData'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import { cn } from '../utils/cn'
import {
  calendarWindow,
  dateKey,
  defaultLocalDateTime,
  formatDayNumber,
  formatHeadingDate,
  formatMonthLabel,
  formatOccurrenceSpan,
  formatOccurrenceTime,
  isMultiDayOccurrence,
  monthGridDays,
  occurrencesForDate,
  startOfDay,
} from '../utils/calendar'

type RecurrenceMode = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
type EditorMode = 'create' | 'edit'
type DashboardContext = {
  id: string
  name: string
}

const WEEKDAY_PICKER_OPTIONS = [
  { label: 'S', name: 'Sun', value: 6 },
  { label: 'M', name: 'Mon', value: 0 },
  { label: 'T', name: 'Tue', value: 1 },
  { label: 'W', name: 'Wed', value: 2 },
  { label: 'R', name: 'Thu', value: 3 },
  { label: 'F', name: 'Fri', value: 4 },
  { label: 'S', name: 'Sat', value: 5 },
] as const

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const EMPTY_OCCURRENCES: CalendarOccurrence[] = []

export function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)
  const [showEditor, setShowEditor] = useState(false)
  const [editorMode, setEditorMode] = useState<EditorMode>('create')
  const [editorEventId, setEditorEventId] = useState<string | null>(null)
  const [editorLoading, setEditorLoading] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [eventLocation, setEventLocation] = useState('')
  const [startsAt, setStartsAt] = useState(defaultLocalDateTime(1))
  const [endsAt, setEndsAt] = useState(defaultLocalDateTime(2))
  const [allDay, setAllDay] = useState(false)
  const [recurrenceMode, setRecurrenceMode] = useState<RecurrenceMode>('none')
  const [recurrenceInterval, setRecurrenceInterval] = useState('1')
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([])
  const [recurrenceEndsOn, setRecurrenceEndsOn] = useState('')
  const [monthCursor, setMonthCursor] = useState(() => startOfDay(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => startOfDay(new Date()))
  const requestedDashboardId = searchParams.get('dashboard_id')
  const [activeDashboardId, setActiveDashboardId] = useInitialDashboardSelection(
    requestedDashboardId,
    'Could not load dashboards for calendar.',
  )
  const occurrenceWindow = useMemo(() => {
    if (!activeDashboardId) return null
    return calendarWindow(monthCursor)
  }, [activeDashboardId, monthCursor])
  const occurrencesQuery = useCalendarOccurrences(
    occurrenceWindow?.start ?? null,
    occurrenceWindow?.end ?? null,
    activeDashboardId,
  )
  const occurrences = occurrencesQuery.data ?? EMPTY_OCCURRENCES
  const { loading } = occurrencesQuery

  useEffect(() => {
    if (recurrenceMode !== 'weekly' || recurrenceWeekdays.length > 0) return
    setRecurrenceWeekdays([toMondayWeekday(new Date(startsAt).getDay())])
  }, [recurrenceMode, recurrenceWeekdays.length, startsAt])

  const monthDays = useMemo(() => monthGridDays(monthCursor), [monthCursor])
  const selectedOccurrences = useMemo(
    () => occurrencesForDate(occurrences, selectedDate),
    [occurrences, selectedDate],
  )
  const durationSummary = getDurationSummary(startsAt, endsAt)
  const overlapWarning =
    recurrenceMode === 'none'
      ? null
      : getRecurringOverlapWarning(startsAt, endsAt, recurrenceMode, recurrenceInterval)
  const today = startOfDay(new Date())
  const activeDashboardSummary = dashboards.find((dashboard) => dashboard.id === activeDashboardId)
  const activeDashboard: DashboardContext | null = activeDashboardSummary
    ? { id: activeDashboardSummary.id, name: activeDashboardSummary.name }
    : null

  function resetEditor() {
    setEditorMode('create')
    setEditorEventId(null)
    setEditorLoading(false)
    setTitle('')
    setDescription('')
    setEventLocation('')
    setStartsAt(defaultLocalDateTime(1))
    setEndsAt(defaultLocalDateTime(2))
    setAllDay(false)
    setRecurrenceMode('none')
    setRecurrenceInterval('1')
    setRecurrenceWeekdays([])
    setRecurrenceEndsOn('')
    setShowEditor(false)
  }

  function openCreateEditor() {
    resetEditor()
    setShowEditor(true)
  }

  function toggleRecurrenceWeekday(weekday: number) {
    setRecurrenceWeekdays((current) => {
      if (current.includes(weekday)) {
        if (current.length === 1) return current
        return current.filter((value) => value !== weekday)
      }
      return [...current, weekday]
    })
  }

  async function openEditEditor(eventId: string) {
    setShowEditor(true)
    setEditorMode('edit')
    setEditorEventId(eventId)
    setEditorLoading(true)

    try {
      const event = await getCalendarEvent(eventId)
      setActiveDashboardId(event.dashboard_id)
      setTitle(event.title)
      setDescription(event.description ?? '')
      setEventLocation(event.location ?? '')
      setStartsAt(toLocalDateTimeInput(event.starts_at))
      setEndsAt(toLocalDateTimeInput(event.ends_at))
      setAllDay(event.all_day)
      setRecurrenceMode(event.recurrence?.frequency ?? 'none')
      setRecurrenceInterval(String(event.recurrence?.interval ?? 1))
      setRecurrenceWeekdays(getInitialWeeklySelection(event.starts_at, event.recurrence))
      setRecurrenceEndsOn(
        event.recurrence ? deriveRecurrenceEndDate(event.starts_at, event.recurrence) : '',
      )
    } catch {
      resetEditor()
    } finally {
      setEditorLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle || !activeDashboardId) return

    const recurrence =
      recurrenceMode === 'none'
        ? null
        : {
            frequency: recurrenceMode,
            interval: Number(recurrenceInterval) || 1,
            until: recurrenceEndsOn ? toRecurrenceUntilIso(recurrenceEndsOn) : undefined,
            ...(recurrenceMode === 'weekly'
              ? { by_weekday: [...recurrenceWeekdays].sort((a, b) => a - b) }
              : {}),
          }

    try {
      if (editorMode === 'edit' && editorEventId) {
        await updateCalendarEvent(editorEventId, {
          title: trimmedTitle,
          description: description.trim() || undefined,
          location: eventLocation.trim() || undefined,
          starts_at: new Date(startsAt).toISOString(),
          ends_at: new Date(endsAt).toISOString(),
          timezone: DEFAULT_TIMEZONE,
          all_day: allDay,
          recurrence,
        })
      } else {
        await createCalendarEvent({
          dashboard_id: activeDashboardId,
          title: trimmedTitle,
          description: description.trim() || undefined,
          location: eventLocation.trim() || undefined,
          starts_at: new Date(startsAt).toISOString(),
          ends_at: new Date(endsAt).toISOString(),
          timezone: DEFAULT_TIMEZONE,
          all_day: allDay,
          recurrence: recurrence ?? undefined,
        })
      }
    } catch {
      return
    }

    resetEditor()
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 pl-12 sm:pl-0 min-h-10">
          <h1 className="min-w-0 flex-1 text-xl font-semibold text-zinc-100 truncate">Calendar</h1>
          <select
            value={activeDashboardId ?? ''}
            disabled={dashboardsLoading || dashboards.length === 0}
            onChange={(event) => {
              const nextDashboardId = event.target.value || null
              setActiveDashboardId(nextDashboardId)
              if (nextDashboardId) {
                setSearchParams({ dashboard_id: nextDashboardId }, { replace: true })
              } else {
                setSearchParams({}, { replace: true })
              }
            }}
            className="min-w-0 max-w-44 sm:max-w-none flex-1 lg:flex-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
          >
            <option value="">Select dashboard</option>
            {dashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
          </select>
          <button
            onClick={openCreateEditor}
            className="shrink-0 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
            disabled={dashboardsLoading || !activeDashboardId}
          >
            <Plus size={16} />
            New event
          </button>
        </div>
        <p className="text-sm text-zinc-500">
          {activeDashboard
            ? `Month view for ${activeDashboard.name}. Everyone on this dashboard sees the same events.`
            : 'Choose a dashboard to view and edit its events.'}
        </p>
      </div>

      {showEditor && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/80 p-4"
        >
          {editorLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
            </div>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Title</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                    placeholder="Family dinner"
                    required
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Location</span>
                  <input
                    value={eventLocation}
                    onChange={(e) => setEventLocation(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                    placeholder="Kitchen"
                  />
                </label>
              </div>

              <label className="grid gap-1.5 text-sm">
                <span className="text-zinc-400">Description</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700 resize-y"
                  placeholder="Optional details"
                />
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Starts</span>
                  <input
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                    required
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Ends</span>
                  <input
                    type="datetime-local"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                    required
                  />
                </label>
              </div>

              {durationSummary && (
                <p className="text-xs text-zinc-500">Duration: {durationSummary}</p>
              )}

              <div className="grid gap-3 md:grid-cols-[1.1fr_0.8fr_1.1fr]">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Repeat</span>
                  <select
                    value={recurrenceMode}
                    onChange={(e) => setRecurrenceMode(e.target.value as RecurrenceMode)}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                  >
                    <option value="none">Does not repeat</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Every</span>
                  <input
                    type="number"
                    min="1"
                    value={recurrenceInterval}
                    onChange={(e) => setRecurrenceInterval(e.target.value)}
                    disabled={recurrenceMode === 'none'}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
                  />
                  <span className="text-xs text-zinc-500">
                    {recurrenceMode === 'none'
                      ? 'Not repeating'
                      : repeatUnitLabel(recurrenceMode, Number(recurrenceInterval) || 1)}
                  </span>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Ends on</span>
                  <input
                    type="date"
                    value={recurrenceEndsOn}
                    onChange={(e) => setRecurrenceEndsOn(e.target.value)}
                    disabled={recurrenceMode === 'none'}
                    className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
                  />
                  <span className="text-xs text-zinc-500">
                    {recurrenceMode === 'none'
                      ? 'Single event'
                      : recurrenceEndsOn
                        ? `Last occurrence on or before ${formatEndDateLabel(recurrenceEndsOn)}`
                        : 'No end date selected'}
                  </span>
                </label>
              </div>

              {recurrenceMode === 'weekly' && (
                <div className="grid gap-1.5 text-sm">
                  <span className="text-zinc-400">Days</span>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAY_PICKER_OPTIONS.map((option) => {
                      const selected = recurrenceWeekdays.includes(option.value)
                      return (
                        <button
                          key={`${option.name}-${option.value}`}
                          type="button"
                          onClick={() => toggleRecurrenceWeekday(option.value)}
                          className={cn(
                            'inline-flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold transition-colors',
                            selected
                              ? 'border-zinc-100 bg-zinc-100 text-zinc-950'
                              : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                          )}
                          aria-pressed={selected}
                          title={option.name}
                        >
                          {option.label}
                        </button>
                      )
                    })}
                  </div>
                  <span className="text-xs text-zinc-500">
                    Repeats on {formatWeeklySelection(recurrenceWeekdays)}.
                  </span>
                </div>
              )}

              {recurrenceMode !== 'none' && (
                <p className="text-xs text-zinc-500">
                  Repeats every {Number(recurrenceInterval) || 1}{' '}
                  {repeatUnitLabel(recurrenceMode, Number(recurrenceInterval) || 1)}
                  {recurrenceMode === 'weekly'
                    ? ` on ${formatWeeklySelection(recurrenceWeekdays)}`
                    : ''}
                  {recurrenceEndsOn ? ` until ${formatEndDateLabel(recurrenceEndsOn)}.` : '.'}
                </p>
              )}

              {overlapWarning && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  {overlapWarning}
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                  className="rounded border-zinc-700 bg-zinc-950"
                />
                All day
              </label>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3">
                <p className="text-sm text-zinc-200">Permissions follow the dashboard</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {editorMode === 'edit'
                    ? `This event stays with ${activeDashboard?.name ?? 'the selected dashboard'} and everyone there sees the same updates.`
                    : `This event will belong to ${activeDashboard?.name ?? 'the selected dashboard'} and use that dashboard's access automatically.`}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-zinc-500">
                  {editorMode === 'edit'
                    ? 'Editing the full event or recurring series.'
                    : 'New events are created directly on the selected dashboard.'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={resetEditor}
                    className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-white transition-colors"
                  >
                    {editorMode === 'edit' ? 'Save changes' : 'Create event'}
                  </button>
                </div>
              </div>
            </>
          )}
        </form>
      )}

      <div className="flex-1 min-h-0 grid gap-4 xl:grid-cols-[1.35fr_0.9fr]">
        <section className="min-h-0 rounded-2xl border border-zinc-800 bg-zinc-900/70 overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 sm:px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setMonthCursor(
                    (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
                  )
                }
                className="rounded-lg p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                aria-label="Previous month"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setMonthCursor(today)
                  setSelectedDate(today)
                }}
                className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
              >
                Today
              </button>
            </div>
            <div className="text-center">
              <h2 className="text-sm font-semibold text-zinc-100">
                {formatMonthLabel(monthCursor)}
              </h2>
              <p className="text-xs text-zinc-500">
                {activeDashboard
                  ? `Events on ${activeDashboard.name}`
                  : 'Choose a dashboard to load events'}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setMonthCursor(
                  (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                )
              }
              className="rounded-lg p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="grid grid-cols-7 border-b border-zinc-800">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
              <div
                key={label}
                className="px-1.5 sm:px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500"
              >
                {label}
              </div>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
            </div>
          ) : (
            <div className="grid grid-cols-7 auto-rows-fr">
              {monthDays.map((day) => {
                const dayOccurrences = occurrencesForDate(occurrences, day)
                const inMonth = day.getMonth() === monthCursor.getMonth()
                const isSelected = dateKey(day) === dateKey(selectedDate)
                const isToday = dateKey(day) === dateKey(new Date())
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    onClick={() => setSelectedDate(startOfDay(day))}
                    className={cn(
                      'min-h-16 sm:min-h-24 lg:min-h-28 border-r border-b border-zinc-800 p-1.5 sm:p-2 text-left align-top transition-colors',
                      'hover:bg-zinc-800/60',
                      !inMonth && 'bg-zinc-950/70 text-zinc-700',
                      isSelected && 'bg-zinc-800/80',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'inline-flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-xs sm:text-sm',
                          inMonth ? 'text-zinc-200' : 'text-zinc-600',
                          isToday && 'bg-zinc-100 text-zinc-950',
                        )}
                      >
                        {formatDayNumber(day)}
                      </span>
                      {dayOccurrences.length > 0 && (
                        <span className="text-[10px] text-zinc-500">{dayOccurrences.length}</span>
                      )}
                    </div>
                    <div className="mt-1 sm:mt-2 space-y-1">
                      {dayOccurrences
                        .slice(0, day.getMonth() === monthCursor.getMonth() ? 2 : 1)
                        .map((occurrence) => (
                          <div
                            key={`${occurrence.event_id}:${occurrence.original_start}`}
                            className={cn(
                              'rounded-md px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-[11px] leading-tight truncate',
                              occurrence.recurring
                                ? 'bg-emerald-500/12 text-emerald-300'
                                : 'bg-sky-500/12 text-sky-300',
                            )}
                            title={buildDayCellTitle(occurrence, day)}
                          >
                            {buildDayCellLabel(occurrence, day)}
                          </div>
                        ))}
                      {dayOccurrences.length >
                        (day.getMonth() === monthCursor.getMonth() ? 2 : 1) && (
                        <p className="px-0.5 text-[10px] text-zinc-500">
                          +
                          {dayOccurrences.length -
                            (day.getMonth() === monthCursor.getMonth() ? 2 : 1)}{' '}
                          more
                        </p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="min-h-0 rounded-2xl border border-zinc-800 bg-zinc-900/70 overflow-hidden flex flex-col">
          <div className="border-b border-zinc-800 px-3 sm:px-4 py-4">
            <h2 className="text-sm font-semibold text-zinc-100">
              {formatHeadingDate(selectedDate)}
            </h2>
            <p className="text-xs text-zinc-500">
              {selectedOccurrences.length === 0
                ? 'No scheduled events'
                : `${selectedOccurrences.length} event${selectedOccurrences.length === 1 ? '' : 's'}`}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 sm:p-4">
            {selectedOccurrences.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center text-zinc-600">
                <CalendarDays size={24} className="mb-3 text-zinc-700" />
                <p className="text-sm">
                  {activeDashboard
                    ? 'Nothing scheduled for this dashboard on this day.'
                    : 'Choose a dashboard to view events.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {selectedOccurrences.map((occurrence) => (
                  <OccurrenceCard
                    key={`${occurrence.event_id}:${occurrence.original_start}`}
                    occurrence={occurrence}
                    onEdit={() => {
                      void openEditEditor(occurrence.event_id)
                    }}
                    onDelete={async () => {
                      const label = occurrence.recurring
                        ? 'Delete this entire series?'
                        : 'Delete this event?'
                      if (await confirm(label)) {
                        void deleteCalendarEvent(occurrence.event_id, activeDashboardId)
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function EventBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
      {children}
    </span>
  )
}

function toMondayWeekday(jsDay: number): number {
  return (jsDay + 6) % 7
}

function shortTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function buildDayCellLabel(occurrence: CalendarOccurrence, day: Date): string {
  if (occurrence.all_day) return `All day ${occurrence.title}`
  if (!isMultiDayOccurrence(occurrence))
    return `${shortTime(occurrence.occurrence_start)} ${occurrence.title}`

  const dayId = dateKey(day)
  const startId = dateKey(occurrence.occurrence_start)
  const endId = dateKey(occurrence.occurrence_end)

  if (dayId === startId)
    return `Starts ${shortTime(occurrence.occurrence_start)} ${occurrence.title}`
  if (dayId === endId) return `Ends ${shortTime(occurrence.occurrence_end)} ${occurrence.title}`
  return `Continues ${occurrence.title}`
}

function buildDayCellTitle(occurrence: CalendarOccurrence, day: Date): string {
  if (!isMultiDayOccurrence(occurrence)) {
    return `${occurrence.title}: ${formatOccurrenceTime(occurrence.occurrence_start, occurrence.occurrence_end, occurrence.all_day)}`
  }

  return `${buildDayCellLabel(occurrence, day)} (${formatOccurrenceSpan(occurrence.occurrence_start, occurrence.occurrence_end, occurrence.all_day)})`
}

function getDurationSummary(startsAt: string, endsAt: string): string | null {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null

  let remainingMinutes = Math.round((end.getTime() - start.getTime()) / 60000)
  const days = Math.floor(remainingMinutes / (60 * 24))
  remainingMinutes -= days * 60 * 24
  const hours = Math.floor(remainingMinutes / 60)
  remainingMinutes -= hours * 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (remainingMinutes > 0 || parts.length === 0) {
    parts.push(`${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`)
  }
  return parts.join(' ')
}

function getRecurringOverlapWarning(
  startsAt: string,
  endsAt: string,
  mode: RecurrenceMode,
  intervalValue: string,
): string | null {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  const interval = Math.max(1, Number(intervalValue) || 1)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null

  const nextStart = new Date(start)
  switch (mode) {
    case 'daily':
      nextStart.setDate(nextStart.getDate() + interval)
      break
    case 'weekly':
      nextStart.setDate(nextStart.getDate() + interval * 7)
      break
    case 'monthly':
      nextStart.setMonth(nextStart.getMonth() + interval)
      break
    case 'yearly':
      nextStart.setFullYear(nextStart.getFullYear() + interval)
      break
    default:
      return null
  }

  if (end <= nextStart) return null
  return 'This event lasts longer than the repeat interval, so repeated occurrences will overlap each other.'
}

function OccurrenceCard({
  occurrence,
  onEdit,
  onDelete,
}: {
  occurrence: CalendarOccurrence
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium text-zinc-100">{occurrence.title}</h3>
            {occurrence.recurring && <EventBadge>Recurring</EventBadge>}
            {occurrence.is_exception && <EventBadge>Exception</EventBadge>}
            {isMultiDayOccurrence(occurrence) && <EventBadge>Multi-day</EventBadge>}
          </div>
          <div className="mt-2 flex flex-col gap-1.5 text-sm text-zinc-400">
            <div className="flex items-center gap-2">
              <Clock3 size={14} className="text-zinc-600" />
              <span>
                {formatOccurrenceSpan(
                  occurrence.occurrence_start,
                  occurrence.occurrence_end,
                  occurrence.all_day,
                )}
              </span>
            </div>
            {occurrence.location && (
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-zinc-600" />
                <span>{occurrence.location}</span>
              </div>
            )}
            {occurrence.recurring && (
              <div className="flex items-center gap-2">
                <Repeat2 size={14} className="text-zinc-600" />
                <span>Series event</span>
              </div>
            )}
          </div>
          {occurrence.description && (
            <p className="mt-3 text-sm text-zinc-500 whitespace-pre-wrap">
              {occurrence.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-lg p-2 text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label={occurrence.recurring ? 'Edit series' : 'Edit event'}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-2 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
            aria-label={occurrence.recurring ? 'Delete series' : 'Delete event'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </article>
  )
}

function repeatUnitLabel(mode: RecurrenceMode, interval: number): string {
  const plural = interval === 1 ? '' : 's'
  switch (mode) {
    case 'daily':
      return `day${plural}`
    case 'weekly':
      return `week${plural}`
    case 'monthly':
      return `month${plural}`
    case 'yearly':
      return `year${plural}`
    default:
      return 'time'
  }
}

function formatWeeklySelection(weekdays: number[]): string {
  const selected = WEEKDAY_PICKER_OPTIONS.filter((option) => weekdays.includes(option.value)).map(
    (option) => option.name,
  )
  return selected.length > 0 ? selected.join(', ') : 'the selected day'
}

function getInitialWeeklySelection(
  startsAt: string,
  recurrence: {
    frequency: string
    interval: number
    until?: string
    count?: number
    by_weekday?: number[]
  } | null,
): number[] {
  if (recurrence?.frequency === 'weekly' && recurrence.by_weekday?.length) {
    return [...new Set(recurrence.by_weekday)].sort((a, b) => a - b)
  }
  return recurrence?.frequency === 'weekly' ? [toMondayWeekday(new Date(startsAt).getDay())] : []
}

function deriveRecurrenceEndDate(
  startsAt: string,
  recurrence: {
    frequency: string
    interval: number
    until?: string
    count?: number
    by_weekday?: number[]
  },
): string {
  if (recurrence.until) return toLocalDateInput(recurrence.until)
  if (!recurrence.count || recurrence.count <= 1) return ''

  const date = new Date(startsAt)
  const repeatsToAdvance = recurrence.count - 1
  for (let index = 0; index < repeatsToAdvance; index += 1) {
    switch (recurrence.frequency) {
      case 'daily':
        date.setDate(date.getDate() + recurrence.interval)
        break
      case 'weekly':
        date.setDate(date.getDate() + recurrence.interval * 7)
        break
      case 'monthly':
        date.setMonth(date.getMonth() + recurrence.interval)
        break
      case 'yearly':
        date.setFullYear(date.getFullYear() + recurrence.interval)
        break
      default:
        return ''
    }
  }
  return toLocalDateInput(date.toISOString())
}

function toRecurrenceUntilIso(value: string): string {
  return new Date(`${value}T23:59:59`).toISOString()
}

function toLocalDateInput(value: string): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatEndDateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`))
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
