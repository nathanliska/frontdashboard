import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { CalendarOccurrence } from '../api/calendar'
import type { CalendarEventParticipantResponse } from '../api/generated/contract'
import { CalendarDayNumber } from '../components/calendar/CalendarDayNumber'
import { CalendarEditor } from '../components/calendar/CalendarEditor'
import { CalendarEditorDialog } from '../components/calendar/CalendarEditorDialog'
import { CalendarTrashPanel } from '../components/calendar/CalendarTrashPanel'
import { OccurrenceCard } from '../components/calendar/OccurrenceCard'
import { ParticipantMicroDots } from '../components/calendar/ParticipantDots'
import { useContainerSize } from '../hooks/useContainerSize'
import { useInitialDashboardSelection } from '../hooks/useInitialDashboardSelection'
import { useLocalDay } from '../hooks/useLocalDay'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  updateCalendarEvent,
  useCalendarOccurrences,
} from '../resources/calendarData'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import {
  buildEventUpdateFromDraft,
  type CalendarEditorDraft,
  createCalendarEditorDraftFromEvent,
  createDefaultCalendarEditorDraft,
  type EditorMode,
  toRecurrenceUntilIso,
} from '../utils/calendar/calendarEditorDraftUtils'
import {
  CALENDAR_MONTH_ROW_HEIGHT,
  CALENDAR_WEEKDAY_LABELS,
  calendarWindow,
  DEFAULT_TIMEZONE,
  dateKey,
  fitOccurrenceRows,
  formatCalendarOccurrenceCellLabel,
  formatCalendarOccurrenceCellTitle,
  formatDayNumber,
  formatHeadingDate,
  formatMonthLabel,
  hiddenOccurrencesTitle,
  monthWeeksInView,
  occurrencesForDate,
  startOfDay,
} from '../utils/calendar/calendarUtils'
import { cn } from '../utils/shared/cn'

type DashboardContext = {
  id: string
  name: string
}
type CalendarEditorSession = {
  key: number
  mode: EditorMode
  eventId: string | null
  initialDraft: CalendarEditorDraft
  initialParticipants: CalendarEventParticipantResponse[]
}

const EMPTY_OCCURRENCES: CalendarOccurrence[] = []

export function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)
  const [editorSession, setEditorSession] = useState<CalendarEditorSession | null>(null)
  const [editorLoading, setEditorLoading] = useState(false)
  const editorRequestId = useRef(0)
  const [showTrash, setShowTrash] = useState(false)
  const [monthCursor, setMonthCursor] = useState(() => startOfDay(new Date()))
  const [selectedDate, setSelectedDate] = useState(() => startOfDay(new Date()))
  const requestedDashboardId = searchParams.get('dashboard_id')
  const [activeDashboardId, setActiveDashboardId] = useInitialDashboardSelection(
    requestedDashboardId,
    'Could not load dashboards for calendar.',
  )
  const activeDashboards = useMemo(() => dashboards, [dashboards])
  const effectiveActiveDashboardId = useMemo(() => {
    if (
      activeDashboardId &&
      activeDashboards.some((dashboard) => dashboard.id === activeDashboardId)
    ) {
      return activeDashboardId
    }
    return activeDashboards[0]?.id ?? null
  }, [activeDashboardId, activeDashboards])
  const occurrenceWindow = useMemo(() => {
    if (!effectiveActiveDashboardId) return null
    return calendarWindow(monthCursor)
  }, [effectiveActiveDashboardId, monthCursor])
  const occurrencesQuery = useCalendarOccurrences(
    occurrenceWindow?.start ?? null,
    occurrenceWindow?.end ?? null,
    effectiveActiveDashboardId,
  )
  const occurrences = occurrencesQuery.data ?? EMPTY_OCCURRENCES
  const { loading, error: occurrencesError, refetch: refetchOccurrences } = occurrencesQuery
  const monthDays = useMemo(() => monthWeeksInView(monthCursor), [monthCursor])
  // Measured because CSS cannot count rows, and one cell answers for all of them: `auto-rows-fr`
  // gives every cell the same height, so the body of the first is the height of every other.
  const [cellBodyRef, cellBody] = useContainerSize({ width: 0, height: 96 })
  const selectedOccurrences = useMemo(
    () => occurrencesForDate(occurrences, selectedDate),
    [occurrences, selectedDate],
  )
  const dayKey = useLocalDay()
  // biome-ignore lint/correctness/useExhaustiveDependencies: dayKey re-runs `new Date()` at the local-day rollover — an intentional trigger dep, not used inside.
  const today = useMemo(() => startOfDay(new Date()), [dayKey])
  const activeDashboard = useMemo<DashboardContext | null>(() => {
    const summary = activeDashboards.find((d) => d.id === effectiveActiveDashboardId)
    return summary ? { id: summary.id, name: summary.name } : null
  }, [activeDashboards, effectiveActiveDashboardId])

  useEffect(() => {
    if (effectiveActiveDashboardId === activeDashboardId) return
    if (effectiveActiveDashboardId) {
      setSearchParams({ dashboard_id: effectiveActiveDashboardId }, { replace: true })
      return
    }
    setSearchParams({}, { replace: true })
  }, [activeDashboardId, effectiveActiveDashboardId, setSearchParams])

  const closeEditor = useCallback(() => {
    editorRequestId.current += 1
    setEditorLoading(false)
    setEditorSession(null)
  }, [])

  function openCreateEditor() {
    editorRequestId.current += 1
    setEditorLoading(false)
    setEditorSession({
      key: editorRequestId.current,
      mode: 'create',
      eventId: null,
      initialDraft: createDefaultCalendarEditorDraft(selectedDate),
      initialParticipants: [],
    })
  }

  async function openEditEditor(eventId: string) {
    editorRequestId.current += 1
    const requestId = editorRequestId.current
    setEditorLoading(true)
    setEditorSession(null)

    try {
      const event = await getCalendarEvent(eventId)
      if (editorRequestId.current !== requestId) return
      setActiveDashboardId(event.dashboard_id)
      setEditorLoading(false)
      setEditorSession({
        key: requestId,
        mode: 'edit',
        eventId,
        initialDraft: createCalendarEditorDraftFromEvent(event),
        initialParticipants: event.participants,
      })
    } catch {
      if (editorRequestId.current !== requestId) return
      setEditorLoading(false)
      setEditorSession(null)
    }
  }

  const handleEditorSubmit = useCallback(
    async (draft: CalendarEditorDraft) => {
      const trimmedTitle = draft.title.trim()
      if (!trimmedTitle || !effectiveActiveDashboardId || !editorSession) return

      const recurrence =
        draft.recurrenceMode === 'none'
          ? null
          : {
              frequency: draft.recurrenceMode,
              interval: Number(draft.recurrenceInterval) || 1,
              until: draft.recurrenceEndsOn
                ? toRecurrenceUntilIso(draft.recurrenceEndsOn)
                : undefined,
              ...(draft.recurrenceMode === 'weekly'
                ? { by_weekday: [...draft.recurrenceWeekdays].sort((a, b) => a - b) }
                : {}),
            }

      try {
        if (editorSession.mode === 'edit' && editorSession.eventId) {
          await updateCalendarEvent(
            editorSession.eventId,
            buildEventUpdateFromDraft(draft, recurrence, DEFAULT_TIMEZONE),
          )
        } else {
          await createCalendarEvent({
            dashboard_id: effectiveActiveDashboardId,
            title: trimmedTitle,
            description: draft.description.trim() || undefined,
            location: draft.eventLocation.trim() || undefined,
            starts_at: new Date(draft.startsAt).toISOString(),
            ends_at: new Date(draft.endsAt).toISOString(),
            timezone: DEFAULT_TIMEZONE,
            all_day: draft.allDay,
            recurrence: recurrence ?? undefined,
            participants: draft.participants,
          })
        }
      } catch {
        return
      }

      closeEditor()
    },
    [closeEditor, editorSession, effectiveActiveDashboardId],
  )

  return (
    <div className="flex min-h-full flex-col gap-4 xl:h-full">
      <div className="flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 pl-12 nav:pl-0 min-h-10">
          <h1 className="min-w-0 flex-1 text-xl font-semibold text-zinc-100 truncate">Calendar</h1>
          <select
            name="dashboard"
            aria-label="Dashboard"
            value={effectiveActiveDashboardId ?? ''}
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
            {activeDashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
          </select>
        </div>
        {!activeDashboard && (
          <p className="text-sm text-zinc-500">Choose a dashboard to view and edit its events.</p>
        )}
      </div>

      <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[1.35fr_0.9fr]">
        <section className="h-[430px] min-h-0 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/70 overflow-hidden flex flex-col sm:h-[560px] xl:h-auto xl:shrink">
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
            <div className="col-span-7 px-2 sm:px-3 pt-2 sm:pt-3">
              <div className="grid grid-cols-7 gap-1">
                {CALENDAR_WEEKDAY_LABELS.map((label) => (
                  <div
                    key={label}
                    className="min-w-0 px-1 py-1 text-center text-[10px] uppercase tracking-[0.18em] text-zinc-500"
                  >
                    {label}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-1 min-h-0 items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
            </div>
          ) : occurrencesError ? (
            // A failed window fetch must not render as an eventless month.
            <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2">
              <p className="text-sm text-zinc-500">Couldn&apos;t load events for this window.</p>
              <button
                type="button"
                onClick={refetchOccurrences}
                className="rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="flex-1 min-h-0 px-2 pb-2 sm:px-3 sm:pb-3">
              <div className="grid h-full grid-cols-7 auto-rows-fr gap-1">
                {monthDays.map((day, index) => {
                  const dayOccurrences = occurrencesForDate(occurrences, day)
                  const inMonth = day.getMonth() === monthCursor.getMonth()
                  const isSelected = dateKey(day) === dateKey(selectedDate)
                  const isToday = dateKey(day) === dateKey(today)
                  const { visible, hidden } = fitOccurrenceRows(
                    cellBody.height,
                    CALENDAR_MONTH_ROW_HEIGHT,
                    dayOccurrences.length,
                  )
                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      onClick={() => setSelectedDate(startOfDay(day))}
                      className="group min-h-0 min-w-0 appearance-none bg-transparent p-0 text-left"
                    >
                      <div
                        className={cn(
                          'flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60 p-1 transition-colors',
                          'group-hover:border-zinc-700 group-hover:bg-zinc-900/80',
                          'group-focus-visible:border-zinc-400 group-focus-visible:ring-1 group-focus-visible:ring-zinc-400/40',
                          !inMonth && 'opacity-45',
                          isToday && 'border-zinc-600 bg-zinc-900',
                          isSelected && 'border-sky-500/40 bg-sky-500/6',
                        )}
                      >
                        <div className="mb-1 flex items-start justify-between gap-1">
                          <CalendarDayNumber
                            value={formatDayNumber(day)}
                            isToday={isToday}
                            isSelected={isSelected}
                            dimmed={!inMonth}
                          />
                        </div>
                        <div
                          ref={index === 0 ? cellBodyRef : null}
                          className="flex-1 min-h-0 overflow-hidden space-y-1"
                        >
                          {dayOccurrences.slice(0, visible).map((occurrence) => (
                            <div
                              key={`${occurrence.event_id}:${occurrence.original_start}`}
                              className={cn(
                                'flex items-center gap-1 rounded px-1 py-0.5 text-[10px]',
                                occurrence.recurring
                                  ? 'bg-emerald-500/12 text-emerald-300'
                                  : 'bg-sky-500/12 text-sky-300',
                              )}
                              title={formatCalendarOccurrenceCellTitle(occurrence, day)}
                            >
                              <ParticipantMicroDots participants={occurrence.participants} />
                              <span className="min-w-0 truncate">
                                {formatCalendarOccurrenceCellLabel(occurrence, day, 'compact')}
                              </span>
                            </div>
                          ))}
                          {hidden > 0 && (
                            <p
                              className="text-[10px] text-zinc-500"
                              title={hiddenOccurrencesTitle(dayOccurrences.slice(visible), day)}
                            >
                              +{hidden}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </section>

        <section className="min-h-0 max-h-[60dvh] rounded-2xl border border-zinc-800 bg-zinc-900/70 overflow-hidden flex flex-col sm:max-h-[520px] xl:max-h-none">
          <div className="border-b border-zinc-800 px-3 sm:px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-zinc-100">
                    {showTrash ? 'Trash' : formatHeadingDate(selectedDate)}
                  </h2>
                  {!showTrash && dateKey(selectedDate) === dateKey(today) && (
                    <span className="rounded-full border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                      Today
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500">
                  {showTrash
                    ? 'Deleted events, restorable for 30 days'
                    : selectedOccurrences.length === 0
                      ? 'No scheduled events'
                      : `${selectedOccurrences.length} event${selectedOccurrences.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowTrash((value) => !value)}
                  disabled={dashboardsLoading || !effectiveActiveDashboardId}
                  aria-pressed={showTrash}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600 aria-pressed:border-zinc-700 aria-pressed:text-zinc-100"
                >
                  <Trash2 size={14} />
                  {showTrash ? 'Back' : 'Trash'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (editorSession?.mode === 'create') {
                      closeEditor()
                      return
                    }
                    setShowTrash(false)
                    openCreateEditor()
                  }}
                  disabled={dashboardsLoading || !effectiveActiveDashboardId}
                  className="shrink-0 flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
                >
                  <Plus size={14} />
                  {editorSession?.mode === 'create' ? 'Close' : 'Add event'}
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4">
            {showTrash ? (
              <CalendarTrashPanel dashboardId={effectiveActiveDashboardId} />
            ) : selectedOccurrences.length > 0 ? (
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
                        void deleteCalendarEvent(occurrence.event_id, effectiveActiveDashboardId)
                      }
                    }}
                  />
                ))}
              </div>
            ) : (
              <SelectedDayEmptyState activeDashboardName={activeDashboard?.name} />
            )}
          </div>
        </section>
      </div>

      {(editorLoading || editorSession) && (
        <CalendarEditorDialog
          title={editorSession?.mode === 'edit' ? 'Edit event' : 'Add event'}
          onClose={closeEditor}
        >
          {editorLoading && <CalendarEditorLoading />}

          {editorSession && (
            <CalendarEditor
              key={editorSession.key}
              mode={editorSession.mode}
              initialDraft={editorSession.initialDraft}
              dashboardId={effectiveActiveDashboardId}
              initialParticipants={editorSession.initialParticipants}
              selectedDate={editorSession.mode === 'create' ? selectedDate : null}
              activeDashboardName={activeDashboard?.name}
              onClose={closeEditor}
              onSubmit={handleEditorSubmit}
            />
          )}
        </CalendarEditorDialog>
      )}
    </div>
  )
}

function CalendarEditorLoading() {
  return (
    <div className="grid gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-zinc-200">Loading event</p>
          <p className="text-xs text-zinc-500">Fetching the latest event details.</p>
        </div>
      </div>
      <div className="flex items-center justify-center py-10">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    </div>
  )
}

function SelectedDayEmptyState({
  activeDashboardName,
  compact = false,
}: {
  activeDashboardName?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center text-zinc-600',
        compact ? 'rounded-xl border border-dashed border-zinc-800 px-4 py-5' : 'h-full',
      )}
    >
      <CalendarDays size={compact ? 20 : 24} className="mb-3 text-zinc-700" />
      <p className="text-sm">
        {activeDashboardName
          ? 'Nothing scheduled for this dashboard on this day.'
          : 'Choose a dashboard to view events.'}
      </p>
    </div>
  )
}
