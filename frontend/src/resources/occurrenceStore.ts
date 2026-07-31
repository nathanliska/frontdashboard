import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { apiListOccurrences, type CalendarOccurrence } from '../api/calendar'
import { registerResourceReset } from './resetRegistry'

/**
 * Occurrence cache indexed by the time intervals it has actually loaded, one entry per dashboard.
 *
 * Keying a cache by request window means two overlapping windows are two unrelated entries, so the
 * calendar page, the calendar widget and the agenda widget each fetched the same days. This tracks
 * which intervals are covered and fetches only the gaps, so a window contained by one already
 * loaded costs no request at all.
 */

type Millis = number

type Interval = { start: Millis; end: Millis }

export type OccurrenceState = {
  occurrences: CalendarOccurrence[]
  /** Distinguishes "no events here" from "nothing fetched yet" — callers render those differently. */
  loaded: boolean
  loading: boolean
  error: Error | null
}

type Entry = {
  dashboardId: string | null
  byKey: Map<string, CalendarOccurrence>
  covered: Interval[]
  /** Windows currently on screen, so invalidation knows what to reload. */
  windows: Map<string, Interval>
  /** Windows requested this tick, coalesced into one fetch on flush. */
  pending: Interval[]
  pendingFlush: Promise<void> | null
  inFlight: Map<string, Promise<void>>
  listeners: Set<() => void>
  state: OccurrenceState
}

/** Matches the backend's own ceiling on a single window, so no retained span is unfetchable. */
const MAX_COVERED_DAYS = 366
const MAX_COVERED_MS = MAX_COVERED_DAYS * 24 * 60 * 60 * 1000

const EMPTY_STATE: OccurrenceState = {
  occurrences: [],
  loaded: false,
  loading: false,
  error: null,
}

const entries = new Map<string, Entry>()

/** Identity of one occurrence: a recurring event yields many, distinguished by original start. */
function occurrenceKey(occurrence: CalendarOccurrence): string {
  return `${occurrence.event_id}|${occurrence.original_start}`
}

function entryKey(dashboardId: string | null): string {
  return dashboardId ?? 'personal'
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/** Merge one interval into a sorted, non-overlapping list, coalescing anything it touches. */
function addInterval(covered: Interval[], next: Interval): Interval[] {
  const merged: Interval[] = []
  let current = next
  for (const interval of covered) {
    // `<=` rather than `<`: abutting intervals are contiguous coverage, not two ranges.
    if (interval.end < current.start || interval.start > current.end) {
      merged.push(interval)
      continue
    }
    current = {
      start: Math.min(current.start, interval.start),
      end: Math.max(current.end, interval.end),
    }
  }
  merged.push(current)
  merged.sort((a, b) => a.start - b.start)
  return merged
}

/** The sub-intervals of `wanted` no covered interval accounts for. */
function gapsIn(covered: Interval[], wanted: Interval): Interval[] {
  const gaps: Interval[] = []
  let cursor = wanted.start
  for (const interval of covered) {
    if (interval.end <= cursor) continue
    if (interval.start >= wanted.end) break
    if (interval.start > cursor)
      gaps.push({ start: cursor, end: Math.min(interval.start, wanted.end) })
    cursor = Math.max(cursor, interval.end)
    if (cursor >= wanted.end) break
  }
  if (cursor < wanted.end) gaps.push({ start: cursor, end: wanted.end })
  return gaps
}

function coveredSpan(covered: Interval[]): number {
  return covered.reduce((total, interval) => total + (interval.end - interval.start), 0)
}

function ensureEntry(dashboardId: string | null): Entry {
  const key = entryKey(dashboardId)
  const existing = entries.get(key)
  if (existing) return existing

  const entry: Entry = {
    dashboardId,
    byKey: new Map(),
    covered: [],
    windows: new Map(),
    pending: [],
    pendingFlush: null,
    inFlight: new Map(),
    listeners: new Set(),
    state: EMPTY_STATE,
  }
  entries.set(key, entry)
  return entry
}

/** Publish a new state object; identity changes only here, so snapshots stay stable. */
function publish(entry: Entry, patch: Partial<OccurrenceState>): void {
  entry.state = { ...entry.state, ...patch }
  for (const listener of [...entry.listeners]) listener()
}

function republishOccurrences(entry: Entry): void {
  const occurrences = [...entry.byKey.values()].sort((a, b) =>
    a.occurrence_start.localeCompare(b.occurrence_start),
  )
  publish(entry, { occurrences })
}

/**
 * Drop coverage furthest from `keep` once the retained span exceeds the cap.
 *
 * Scrolling a calendar forever would otherwise accumulate every month ever viewed.
 */
function trim(entry: Entry, keep: Interval): void {
  if (coveredSpan(entry.covered) <= MAX_COVERED_MS) return

  const distance = (interval: Interval) =>
    Math.max(0, Math.max(keep.start - interval.end, interval.start - keep.end))
  const retained: Interval[] = []
  let span = 0
  for (const interval of [...entry.covered].sort((a, b) => distance(a) - distance(b))) {
    const width = interval.end - interval.start
    if (span + width > MAX_COVERED_MS && retained.length > 0) continue
    retained.push(interval)
    span += width
  }
  retained.sort((a, b) => a.start - b.start)
  entry.covered = retained

  for (const [key, occurrence] of entry.byKey) {
    const at = {
      start: Date.parse(occurrence.occurrence_start),
      end: Date.parse(occurrence.occurrence_end),
    }
    if (!retained.some((interval) => overlaps(interval, at))) entry.byKey.delete(key)
  }
}

/**
 * Fetch one interval and reconcile it into the entry.
 *
 * Everything overlapping the range is deleted before the response is inserted: the server is
 * authoritative for the range it was asked about, so an occurrence it no longer returns is gone.
 */
async function fetchInterval(entry: Entry, interval: Interval): Promise<void> {
  const key = `${interval.start}:${interval.end}`
  const existing = entry.inFlight.get(key)
  if (existing) return existing

  const request = (async () => {
    const fetched = await apiListOccurrences({
      windowStart: new Date(interval.start).toISOString(),
      windowEnd: new Date(interval.end).toISOString(),
      dashboardId: entry.dashboardId,
    })

    for (const [existingKey, occurrence] of entry.byKey) {
      const at = {
        start: Date.parse(occurrence.occurrence_start),
        end: Date.parse(occurrence.occurrence_end),
      }
      if (overlaps(at, interval)) entry.byKey.delete(existingKey)
    }
    for (const occurrence of fetched) entry.byKey.set(occurrenceKey(occurrence), occurrence)

    entry.covered = addInterval(entry.covered, interval)
    trim(entry, interval)
  })().finally(() => {
    entry.inFlight.delete(key)
  })

  entry.inFlight.set(key, request)
  return request
}

/** Load whatever part of `wanted` is missing. Resolves immediately when nothing is. */
async function runLoad(entry: Entry, wanted: Interval): Promise<void> {
  const gaps = gapsIn(entry.covered, wanted)
  if (gaps.length === 0) return

  const hadData = entry.byKey.size > 0
  publish(entry, { loading: !hadData, error: null })
  try {
    await Promise.all(gaps.map((gap) => fetchInterval(entry, gap)))
    republishOccurrences(entry)
    publish(entry, { loaded: true, loading: false, error: null })
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error('Failed to load calendar events.')
    publish(entry, { loading: false, error: normalized })
  }
}

/**
 * Batch the windows asked for in one tick into a single spanning fetch.
 *
 * Widgets mount together, so without this the agenda and calendar widgets each see empty coverage
 * and issue their own overlapping request — the duplication this store exists to remove.
 */
function loadWindow(dashboardId: string | null, wanted: Interval): Promise<void> {
  const entry = ensureEntry(dashboardId)
  entry.pending.push(wanted)
  if (entry.pendingFlush) return entry.pendingFlush

  entry.pendingFlush = Promise.resolve().then(() => {
    const batch = entry.pending
    entry.pending = []
    entry.pendingFlush = null
    const span = {
      start: Math.min(...batch.map((interval) => interval.start)),
      end: Math.max(...batch.map((interval) => interval.end)),
    }
    // Fall back to per-window loads rather than fetch a span the backend would reject.
    if (span.end - span.start > MAX_COVERED_MS) {
      return Promise.all(batch.map((interval) => runLoad(entry, interval))).then(() => undefined)
    }
    return runLoad(entry, span)
  })
  return entry.pendingFlush
}

function subscribe(dashboardId: string | null, listener: () => void): () => void {
  const entry = ensureEntry(dashboardId)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
  }
}

/**
 * The span every mounted reader of this dashboard is watching, as one interval.
 *
 * Invalidation refetches this rather than each window separately: concurrent loads would all see
 * the same emptied coverage and fire overlapping requests, which is the duplication being removed.
 */
function watchedInterval(entry: Entry): Interval | null {
  if (entry.windows.size === 0) return null
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const window of entry.windows.values()) {
    start = Math.min(start, window.start)
    end = Math.max(end, window.end)
  }
  return end - start > MAX_COVERED_MS ? null : { start, end }
}

let nextWatcherId = 0

/** Occurrences overlapping the window, from the shared per-dashboard cache. */
export function useOccurrences(
  dashboardId: string | null,
  windowStart: string | null,
  windowEnd: string | null,
) {
  const watcherId = useMemo(() => `w${nextWatcherId++}`, [])
  const wanted = useMemo<Interval | null>(() => {
    if (!windowStart || !windowEnd) return null
    return { start: Date.parse(windowStart), end: Date.parse(windowEnd) }
  }, [windowStart, windowEnd])

  const state = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(dashboardId, listener), [dashboardId]),
    () => ensureEntry(dashboardId).state,
    () => EMPTY_STATE,
  )

  // Registered as well as fetched: invalidation has to know which windows are on screen, or an
  // SSE event would clear coverage that nothing then reloads and the UI would sit stale.
  useEffect(() => {
    if (!wanted) return
    const entry = ensureEntry(dashboardId)
    entry.windows.set(watcherId, wanted)
    void loadWindow(dashboardId, wanted).catch(() => undefined)
    return () => {
      entry.windows.delete(watcherId)
    }
  }, [dashboardId, wanted, watcherId])

  const data = useMemo(() => {
    if (!wanted) return EMPTY_STATE.occurrences
    return state.occurrences.filter((occurrence) =>
      overlaps(
        {
          start: Date.parse(occurrence.occurrence_start),
          end: Date.parse(occurrence.occurrence_end),
        },
        wanted,
      ),
    )
  }, [state.occurrences, wanted])

  const refetch = useCallback(() => {
    if (!wanted) return
    const entry = ensureEntry(dashboardId)
    entry.covered = []
    void loadWindow(dashboardId, wanted).catch(() => undefined)
  }, [dashboardId, wanted])

  return { data, loaded: state.loaded, loading: state.loading, error: state.error, refetch }
}

/** Drop coverage and reload what is on screen; held occurrences stay visible until it resolves. */
export function invalidateOccurrences(dashboardId: string | null): void {
  const entry = entries.get(entryKey(dashboardId))
  if (!entry) return
  reload(entry)
}

export function invalidateAllOccurrences(): void {
  for (const entry of entries.values()) reload(entry)
}

function reload(entry: Entry): void {
  entry.covered = []
  const watched = watchedInterval(entry)
  if (!watched) {
    publish(entry, {})
    return
  }
  void loadWindow(entry.dashboardId, watched).catch(() => undefined)
}

export function resetOccurrences(): void {
  entries.clear()
}

registerResourceReset(resetOccurrences)
