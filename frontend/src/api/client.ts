// Both names, because only production can prefix the cookie (`__Host-` requires Secure). Ordered,
// not optional: a browser holding a superseded `csrf_token` carries both, and one regex with an
// optional prefix returns whichever came first — the stale one 403s every mutation.
const CSRF_COOKIE_NAMES = ['__Host-csrf_token', 'csrf_token'] as const

function getCsrfToken(): string {
  for (const name of CSRF_COOKIE_NAMES) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
    if (match) return decodeURIComponent(match[1])
  }
  return ''
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Worth retrying: the server or the path to it failed, which says nothing about our credentials.
// 429 is deliberately absent — also not a logout, but retrying it is the opposite of complying.
const TRANSIENT_STATUS = new Set([500, 502, 503, 504])

const MAX_ATTEMPTS = 2
const RETRY_BASE_MS = 300

// Kept so tests can cancel them: workers are reused across files, and an uncleared setTimeout
// holds its closure for the rest of the run.
const pendingRetries = new Set<ReturnType<typeof setTimeout>>()

let onSessionExpired: () => void = () => {}

/**
 * Register what happens when the server says we are not authenticated. `stores/auth` owns the
 * actual transition; wiring it through a handler rather than importing the store keeps this
 * module free of the cycle (`stores/auth` → `api/auth` → `api/client`).
 */
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler
}

/**
 * Full jitter (AWS, "Exponential Backoff and Jitter"). Every tab that dropped at the same instant
 * — during a deploy, that is all of them — would otherwise retry at the same instant too, against
 * the single worker that just came back up.
 */
function retryDelayMs(attempt: number): number {
  return Math.random() * RETRY_BASE_MS * 2 ** attempt
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(() => {
      pendingRetries.delete(handle)
      resolve()
    }, ms)
    pendingRetries.add(handle)
  })
}

export function __resetApiClientForTests(): void {
  for (const handle of pendingRetries) clearTimeout(handle)
  pendingRetries.clear()
  onSessionExpired = () => {}
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

  // GET only — echo suppression, not idempotency: the pending `client_mutation_id` is consumed
  // by the first SSE frame, so a retry's second frame reads as someone else's change.
  const maxAttempts = MUTATING.has(method) ? 1 : MAX_ATTEMPTS

  for (let attempt = 0; ; attempt++) {
    const lastAttempt = attempt + 1 >= maxAttempts
    let res: Response
    try {
      res = await fetch(path, { ...init, headers, credentials: 'include' })
    } catch (error) {
      // Network failure says nothing about our credentials: retry, then surface. Never a logout.
      if (lastAttempt) throw error
      await wait(retryDelayMs(attempt))
      continue
    }

    // 401 only. Not 403 — that is the permission layer ("editor access required"), and treating
    // it as a session failure would sign you out for opening someone else's dashboard.
    if (res.status === 401) {
      onSessionExpired()
      return res
    }

    if (TRANSIENT_STATUS.has(res.status) && !lastAttempt) {
      await wait(retryDelayMs(attempt))
      continue
    }
    return res
  }
}
