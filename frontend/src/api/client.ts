function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// 'refreshed' — new tokens issued. 'rate-limited' — /refresh returned 429 (a burst
// of tabs refreshing at once); the session is NOT lost, so callers back off instead
// of redirecting to /login. 'unauthorized' — anything else, treat as logged out.
export type RefreshOutcome = 'refreshed' | 'rate-limited' | 'unauthorized'

let refreshPromise: Promise<RefreshOutcome> | null = null

export function tryRefresh(): Promise<RefreshOutcome> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    })
      .then(
        (r): RefreshOutcome =>
          r.ok ? 'refreshed' : r.status === 429 ? 'rate-limited' : 'unauthorized',
      )
      .catch((): RefreshOutcome => 'unauthorized')
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (MUTATING.has(method) && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (MUTATING.has(method)) {
    headers.set('X-CSRF-Token', getCsrfToken())
  }

  const res = await fetch(path, { ...init, headers, credentials: 'include' })

  if (res.status === 401) {
    const outcome = await tryRefresh()
    if (outcome === 'rate-limited') {
      // Refresh is momentarily throttled — don't log the user out over a transient
      // 429. Surface the original 401 so a later retry, under the limit, refreshes.
      return res
    }
    if (outcome === 'unauthorized') {
      window.location.replace('/login')
      return new Promise(() => {}) // never resolves — navigation is underway
    }
    // Retry with refreshed CSRF cookie
    if (MUTATING.has(method)) {
      headers.set('X-CSRF-Token', getCsrfToken())
    }
    return fetch(path, { ...init, headers, credentials: 'include' })
  }

  return res
}
