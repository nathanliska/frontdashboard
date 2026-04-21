import { useEffect, useSyncExternalStore } from 'react'

export interface ScopedQueryState<Data> {
  data: Data | null
  loading: boolean
  error: Error | null
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
}

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
}: CreateScopedQueryOptions<Scope, Data>) {
  const entries = new Map<string, ScopedQueryEntry<Scope, Data>>()

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
    return entry
  }

  function notify(entry: ScopedQueryEntry<Scope, Data>) {
    entry.listeners.forEach((listener) => {
      listener()
    })
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

  function invalidateWhere(
    predicate: (scope: Scope) => boolean,
    options: ScopedQueryFetchOptions & { activeOnly?: boolean } = {},
  ): void {
    const activeOnly = options.activeOnly ?? true

    for (const entry of entries.values()) {
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
    for (const entry of entries.values()) {
      if (!predicate(entry.scope)) continue
      entry.stale = false
      setState(entry, updater(entry.state, entry.scope))
    }
  }

  function reset(): void {
    entries.clear()
  }

  function useQuery(scope: Scope | null | undefined): ScopedQueryState<Data> {
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

    return state
  }

  return {
    fetch,
    getState,
    invalidateWhere,
    reset,
    updateWhere,
    useQuery,
  }
}
