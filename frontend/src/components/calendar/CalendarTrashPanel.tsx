import { RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGetEventTrash, type EventTrashCursor, type TrashedEvent } from '../../api/calendar'
import { purgeCalendarEvent, restoreCalendarEvent } from '../../resources/calendarData'
import { confirm } from '../../stores/confirm'
import { toast } from '../../stores/toast'
import { formatHeadingDate } from '../../utils/calendar/calendarUtils'

/**
 * The calendar's trash: deleted events still inside the retention window.
 *
 * Deleting an event offers an undo on its toast, but that lasts seconds while the row lasts 30
 * days — this is the surface that reaches it afterwards ([ADR-007](../../../../docs/adr/ADR-007-soft-delete-boundary.md)).
 *
 * Takes no change callback: restoring invalidates the occurrence cache from `calendarData`, which
 * is also the path the toast undo takes and the only one that reaches both.
 */
export function CalendarTrashPanel({ dashboardId }: { dashboardId: string | null }) {
  const [entries, setEntries] = useState<TrashedEvent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Null means the server said there is no page after this one. It is never derived here — a client
  // that decided by counting rows would silently truncate the moment the page size moved.
  const [nextCursor, setNextCursor] = useState<EventTrashCursor | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    if (!dashboardId) {
      setEntries([])
      return
    }
    try {
      setFailed(false)
      const page = await apiGetEventTrash(dashboardId)
      setEntries(page.items)
      setNextCursor(page.next_cursor ?? null)
    } catch (error) {
      // Not an empty list: "nothing in the trash" is a claim, and making it after a failed fetch
      // tells the user their deleted events are gone when they may not be.
      setFailed(true)
      setEntries([])
      setNextCursor(null)
      toast.error(error instanceof Error ? error.message : 'Failed to load trashed events.')
    }
  }, [dashboardId])

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const page = await apiGetEventTrash(dashboardId, nextCursor)
      // Appended, never merged: the cursor makes each page disjoint from the ones before it.
      setEntries((current) => [...(current ?? []), ...page.items])
      setNextCursor(page.next_cursor ?? null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load more trashed events.')
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  async function handleRestore(entry: TrashedEvent) {
    setBusyId(entry.id)
    try {
      if (await restoreCalendarEvent(entry.id, dashboardId)) {
        setEntries((current) => (current ?? []).filter((e) => e.id !== entry.id))
      }
    } finally {
      setBusyId(null)
    }
  }

  async function handlePurge(entry: TrashedEvent) {
    // The one irreversible action here, so it says so before doing it.
    const message = `Permanently delete "${entry.title}"? This cannot be undone.`
    if (!(await confirm(message, { confirmLabel: 'Delete permanently' }))) return
    setBusyId(entry.id)
    try {
      if (await purgeCalendarEvent(entry.id)) {
        setEntries((current) => (current ?? []).filter((e) => e.id !== entry.id))
        toast.success(`Permanently deleted "${entry.title}".`)
      }
    } finally {
      setBusyId(null)
    }
  }

  if (entries === null) {
    return <p className="text-sm text-zinc-500">Loading trash…</p>
  }

  if (failed) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          Couldn't load the trash. Your deleted events are still there.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          Try again
        </button>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Nothing in the trash. Deleted events stay here for 30 days before they are removed.
      </p>
    )
  }

  return (
    <>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-zinc-200">{entry.title}</p>
              <p className="text-xs text-zinc-500">
                {formatHeadingDate(new Date(entry.starts_at))}
                {entry.recurring ? ' · repeats' : ''} · deleted{' '}
                {new Date(entry.deleted_at).toLocaleDateString()} · removed{' '}
                {new Date(entry.purge_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void handleRestore(entry)}
                disabled={busyId === entry.id}
                aria-label={`Restore ${entry.title}`}
                title="Restore"
                className="rounded-lg p-2 text-zinc-500 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
              >
                <RotateCcw size={14} />
              </button>
              <button
                type="button"
                onClick={() => void handlePurge(entry)}
                disabled={busyId === entry.id}
                aria-label={`Permanently delete ${entry.title}`}
                title="Delete permanently"
                className="rounded-lg p-2 text-zinc-500 transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:text-zinc-700"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <button
          type="button"
          onClick={() => void handleLoadMore()}
          disabled={loadingMore}
          className="mt-2 w-full rounded-lg border border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
        >
          {loadingMore ? 'Loading…' : 'Load older'}
        </button>
      )}
    </>
  )
}
