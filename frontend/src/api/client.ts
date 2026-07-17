function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let refreshPromise: Promise<boolean> | null = null

export function tryRefresh(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    })
      .then((r) => r.ok)
      .catch(() => false)
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
    const ok = await tryRefresh()
    if (!ok) {
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
