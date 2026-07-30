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
    }
    entries.set(key, entry)
    // The new entry is newest in iteration order, so it is never the one evicted here.
    evictColdEntries()
    return entry
  }

  function notify(entry: ScopedQueryEntry<Scope, Data>) {
    // Snapshot, for the same reason `invalidateWhere` does: `Set.forEach` visits entries added
    // during iteration, so a listener that subscribed synchronously would be invoked in this same
    // pass. Today's listeners are `useSyncExternalStore` callbacks that only schedule a render, so
    // this is insurance rather than a live bug — but it is one refactor away from being one.
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

    entry.stale = false

    const request = fetcher(entry.scope)
      .then((data) => {
        setState(entry, { data, loading: false, error: null })
        return data
      })
      .catch((error) => {
        const normalizedError = toError(error, fallbackErrorMessage)
        setState(entry, {
          data: entry.state.data,
          loading: false,
          error: normalizedError,
        })
        throw normalizedError
      })
      .finally(() => {
        if (entry.inFlight === request) {
          entry.inFlight = null
        }
      })

    entry.inFlight = request
    return request
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

    // Iterate a snapshot, not the live map. `fetch` runs synchronously up to its first await, and
    // one of those first statements is `touch`, which deletes and re-inserts the entry to move it
    // to the back of the LRU order. A Map iterator *does* visit entries inserted during iteration,
    // so iterating live would hand this loop the same entry again on the very next step — matching
    // the predicate, fetching, touching, re-inserting — until the heap gave out.
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
      // Deliberately does not touch `stale`. A patch writes part of an entry; it is not a
      // refetch, so it cannot resolve "the server has changes we haven't seen". Only fetch()
      // clears `stale`, because only fetch() writes authoritative full data. Clearing it here
      // would silently discard an invalidate whose fetch was skipped for lack of listeners,
      // losing that update until a resync.
      setState(entry, updater(entry.state, entry.scope))
    }
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
    reset,
    updateWhere,
    useQuery,
  }
}
