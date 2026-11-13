import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

export interface ScopedQueryState<Data> {
  data: Data | null
  loading: boolean
  error: Error | null
}

export interface ScopedQueryResult<Data> extends ScopedQueryState<Data> {
  /** Re-run the fetch for this scope. The affordance behind every "Try again" button. */
  refetch: () => void
}

type ScopedQueryFetchOptions = {
  background?: boolean
}

type ScopedQueryEntry<Scope, Data> = {
  key: string
  scope: Scope
  state: ScopedQueryState<Data>
  listeners: Set<() => void>
  inFlight: Promise<Data> | null
  stale: boolean
  /** Counts writes to the entry, so a read can tell that one overtook it. */
  writes: number
  /** A patch overtook the read in flight. Not `stale`: what is held is newer, only partial. */
  owed: boolean
}

type CreateScopedQueryOptions<Scope, Data> = {
  getKey: (scope: Scope) => string
  fetcher: (scope: Scope) => Promise<Data>
  fallbackErrorMessage?: string
  /** How many scopes to keep cached. See `evictColdEntries` for what "cached" excludes. */
  maxCachedScopes?: number
}

/** Cached scopes kept per query before the coldest are dropped.
 *
 * Unbounded, a tab left open on the calendar grows one entry per window scrolled to. 32 covers a
 * year of windows plus every dashboard's lists; past that the coldest are worth less than the
 * memory.
 */
const DEFAULT_MAX_CACHED_SCOPES = 32

const EMPTY_STATE: ScopedQueryState<never> = {
  data: null,
  loading: false,
  error: null,
}

function toError(error: unknown, fallbackErrorMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackErrorMessage)
}

export function createScopedQuery<Scope, Data>({
  getKey,
  fetcher,
  fallbackErrorMessage = 'Failed to load data.',
  maxCachedScopes = DEFAULT_MAX_CACHED_SCOPES,
}: CreateScopedQueryOptions<Scope, Data>) {
  // Insertion-ordered, and that order *is* the recency order: `touch` re-inserts on fetch, so
  // iterating from the front walks coldest-first.
  const entries = new Map<string, ScopedQueryEntry<Scope, Data>>()

  /** Mark an entry as recently used by moving it to the back of the eviction order. */
  function touch(entry: ScopedQueryEntry<Scope, Data>): void {
    if (entries.delete(entry.key)) entries.set(entry.key, entry)
  }

  /** Drop the coldest entries nothing is using, down to `maxCachedScopes`.
   *
   * Two kinds of entry are pinned and skipped regardless of age: one with **listeners** (a
   * mounted component reads it through `useSyncExternalStore`, and evicting would hand it a
   * fresh empty entry on the next snapshot), and one with a request **in flight** (the response
   * would resolve into an entry no longer in the map, silently discarding it). If everything is
   * pinned the cache simply stays over its cap — correctness first, memory second.
   */
  function evictColdEntries(): void {
    if (entries.size <= maxCachedScopes) return
    for (const entry of entries.values()) {
      if (entries.size <= maxCachedScopes) break
      if (entry.listeners.size > 0 || entry.inFlight) continue
      entries.delete(entry.key)
    }
  }

  function ensureEntry(scope: Scope): ScopedQueryEntry<Scope, Data> {
    const key = getKey(scope)
    const existing = entries.get(key)
    if (existing) {
      existing.scope = scope
      return existing
    }

    const entry: ScopedQueryEntry<Scope, Data> = {
      key,
      scope,
      state: EMPTY_STATE as ScopedQueryState<Data>,
      listeners: new Set(),
      inFlight: null,
      stale: false,
      writes: 0,
      owed: false,
    }
    entries.set(key, entry)
    // The new entry is newest in iteration order, so it is never the one evicted here.
    evictColdEntries()
    return entry
  }

  function notify(entry: ScopedQueryEntry<Scope, Data>) {
    // Snapshot: `Set.forEach` visits entries added mid-iteration, so a listener that subscribed
    // synchronously would run in this same pass. Insurance today, since every listener only
    // schedules a render, and one refactor away from a live bug.
    for (const listener of [...entry.listeners]) {
      listener()
    }
  }

  function setState(entry: ScopedQueryEntry<Scope, Data>, nextState: ScopedQueryState<Data>): void {
    const currentState = entry.state
    if (
      currentState.data === nextState.data &&
      currentState.loading === nextState.loading &&
      currentState.error === nextState.error
    ) {
      return
    }

    entry.state = nextState
    notify(entry)
  }

  function getState(scope: Scope): ScopedQueryState<Data> {
    return ensureEntry(scope).state
  }

  function isStale(scope: Scope): boolean {
    return ensureEntry(scope).stale
  }

  async function fetch(scope: Scope, options: ScopedQueryFetchOptions = {}): Promise<Data> {
    const entry = ensureEntry(scope)
    // A fetch is the honest signal that a scope is in use — reads happen on every render and
    // would make recency meaningless.
    touch(entry)
    if (entry.inFlight) {
      return entry.inFlight
    }

    const hasData = entry.state.data !== null
    const background = options.background ?? hasData

    if (!background || !hasData) {
      setState(entry, {
        data: entry.state.data,
        loading: true,
        error: null,
      })
    } else if (entry.state.error) {
      setState(entry, {
        data: entry.state.data,
        loading: false,
        error: null,
      })
    }

    const request = read(entry)
    entry.inFlight = request
    return request
  }

  // A throw before the promise exists becomes a rejection, so `read` never settles in the same
  // step that started it and `fetch` can record it as in flight first.
  function callFetcher(scope: Scope): Promise<Data> {
    try {
      return fetcher(scope)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Read a scope until the answer is known to be no older than what the entry holds.
   *
   * A read is overtaken when the entry is written while it is out. Its answer may predate that
   * write, so it is dropped rather than applied — see ADR-006.
   */
  async function read(entry: ScopedQueryEntry<Scope, Data>): Promise<Data> {
    let writes = entry.writes
    try {
      for (;;) {
        writes = entry.writes
        entry.stale = false
        entry.owed = false
        const data = await callFetcher(entry.scope)
        const overtaken = entry.writes !== writes
        // Read again: a patch is partial, and an invalidate mid-flight is newer than this read.
        // Nobody watching an invalidated scope means the next mount reads it instead.
        if (entry.owed || (entry.stale && entry.listeners.size > 0)) {
          if (!overtaken) setState(entry, { data, loading: false, error: null })
          continue
        }
        // Cleared before notifying, so a listener that reads again starts a new request.
        entry.inFlight = null
        if (overtaken && entry.state.data !== null) {
          // Overtaken by a seed, which is authoritative: keep it.
          setState(entry, { ...entry.state, loading: false })
          return entry.state.data
        }
        setState(entry, { data, loading: false, error: null })
        return data
      }
    } catch (error) {
      entry.inFlight = null
      const held = entry.state.data
      // The read a patch was owed never came, so the next mount has to make it.
      if (entry.owed) entry.stale = true
      // A seed needs no read, so the failure of one it overtook is not shown.
      if (entry.writes !== writes && !entry.stale && held !== null) {
        setState(entry, { data: held, loading: false, error: null })
        return held
      }
      const normalizedError = toError(error, fallbackErrorMessage)
      setState(entry, { data: held, loading: false, error: normalizedError })
      throw normalizedError
    }
  }

  async function fetchIfStale(scope: Scope): Promise<Data> {
    const entry = ensureEntry(scope)
    if (entry.inFlight) return entry.inFlight
    if (entry.state.data !== null && !entry.stale) return entry.state.data
    return fetch(scope)
  }

  function invalidateWhere(
    predicate: (scope: Scope) => boolean,
    options: ScopedQueryFetchOptions & { activeOnly?: boolean } = {},
  ): void {
    const activeOnly = options.activeOnly ?? true

    // Iterate a snapshot: `fetch` runs synchronously up to its first await, and `touch` there
    // re-inserts the entry at the back of the LRU. A live Map iterator visits inserted entries, so
    // this loop would meet the same entry again on the very next step, until the heap gave out.
    for (const entry of [...entries.values()]) {
      if (!predicate(entry.scope)) continue
      entry.stale = true

      if (activeOnly && entry.listeners.size === 0) continue

      void fetch(entry.scope, {
        background: options.background ?? entry.state.data !== null,
      }).catch(() => undefined)
    }
  }

  function updateWhere(
    predicate: (scope: Scope) => boolean,
    updater: (state: ScopedQueryState<Data>, scope: Scope) => ScopedQueryState<Data>,
  ): void {
    // Snapshot for the same reason as `invalidateWhere`: `setState` notifies listeners, and a
    // listener is arbitrary component code that may re-enter the cache and reorder it mid-loop.
    for (const entry of [...entries.values()]) {
      if (!predicate(entry.scope)) continue
      // Leaves `stale` alone: a patch writes part of an entry, not authoritative full data, so
      // only fetch() may clear it. Clearing here would discard an invalidate whose fetch was
      // skipped for lack of listeners, losing that update until a resync.
      const next = updater(entry.state, entry.scope)
      if (next.data !== entry.state.data || next.error !== entry.state.error) {
        entry.writes += 1
        // A patch is partial, so a read it overtakes is owed again.
        if (entry.inFlight) entry.owed = true
      }
      setState(entry, next)
    }
  }

  /**
   * Patch what a scope holds, or invalidate it when it holds nothing or `patch` declines with null.
   *
   * An event that cannot be applied still has to be recorded, or a read already in flight would
   * settle as current. Returns whether it patched.
   */
  function patchOrInvalidate(scope: Scope, patch: (data: Data) => Data | null): boolean {
    const { key, state } = ensureEntry(scope)
    const next = state.data === null ? null : patch(state.data)
    const isScope = (candidate: Scope) => getKey(candidate) === key
    if (next === null) {
      invalidateWhere(isScope)
      return false
    }
    updateWhere(isScope, (current) => ({ ...current, data: next }))
    return true
  }

  // For data the client holds in full without fetching, such as a row it just created. Unlike a
  // patch this is authoritative, so it clears `stale`.
  function seed(scope: Scope, data: Data): void {
    const entry = ensureEntry(scope)
    entry.stale = false
    entry.owed = false
    entry.writes += 1
    setState(entry, { data, loading: false, error: null })
  }

  function reset(): void {
    entries.clear()
  }

  function useQuery(scope: Scope | null | undefined): ScopedQueryResult<Data> {
    if (scope) ensureEntry(scope)

    const state = useSyncExternalStore(
      (listener) => {
        if (!scope) {
          return () => {}
        }

        const entry = ensureEntry(scope)
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
        }
      },
      () => {
        if (!scope) {
          return EMPTY_STATE as ScopedQueryState<Data>
        }

        return ensureEntry(scope).state
      },
      () => {
        if (!scope) {
          return EMPTY_STATE as ScopedQueryState<Data>
        }

        return ensureEntry(scope).state
      },
    )

    useEffect(() => {
      if (!scope) return

      const entry = ensureEntry(scope)
      if (entry.state.data === null || entry.stale) {
        void fetch(scope, { background: entry.state.data !== null }).catch(() => undefined)
      }
    }, [scope])

    const refetch = useCallback(() => {
      if (!scope) return
      void fetch(scope).catch(() => undefined)
    }, [scope])

    return useMemo(() => ({ ...state, refetch }), [state, refetch])
  }

  return {
    fetch,
    fetchIfStale,
    getState,
    invalidateWhere,
    isStale,
    patchOrInvalidate,
    reset,
    seed,
    updateWhere,
    useQuery,
  }
}
