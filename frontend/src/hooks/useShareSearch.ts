import { useEffect, useMemo, useState } from 'react'
import { apiSearchUsers, type SearchUserResult } from '../api/users'
import type { ShareSearchCandidate } from '../utils/share/sharePanelTypes'

const SEARCH_DEBOUNCE_MS = 250
const EMPTY_RESULTS: SearchUserResult[] = []
const EMPTY_CANDIDATES: ShareSearchCandidate[] = []

type ShareSearchState = {
  query: string
  loading: boolean
  results: SearchUserResult[]
}

export function useShareSearch(query: string): {
  candidates: ShareSearchCandidate[]
  searching: boolean
} {
  const [searchState, setSearchState] = useState<ShareSearchState>({
    query: '',
    loading: false,
    results: EMPTY_RESULTS,
  })
  const trimmedQuery = query.trim()

  useEffect(() => {
    if (trimmedQuery.length < 2) return

    let cancelled = false
    const timeout = window.setTimeout(() => {
      setSearchState((current) => ({
        query: trimmedQuery,
        loading: true,
        results: current.query === trimmedQuery ? current.results : EMPTY_RESULTS,
      }))

      void apiSearchUsers(trimmedQuery)
        .then((nextResults) => {
          if (!cancelled) {
            setSearchState({
              query: trimmedQuery,
              loading: false,
              results: nextResults,
            })
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchState({
              query: trimmedQuery,
              loading: false,
              results: EMPTY_RESULTS,
            })
          }
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [trimmedQuery])

  const candidates = useMemo<ShareSearchCandidate[]>(() => {
    if (trimmedQuery.length < 2 || searchState.query !== trimmedQuery) return EMPTY_CANDIDATES

    return searchState.results.map((user) => ({
      id: user.id,
      label: user.display_name,
      meta: user.email,
      principal_type: 'user',
    }))
  }, [searchState.query, searchState.results, trimmedQuery])

  return {
    candidates,
    searching:
      trimmedQuery.length >= 2 && (searchState.query !== trimmedQuery || searchState.loading),
  }
}
