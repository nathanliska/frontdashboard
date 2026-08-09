// @vitest-environment jsdom
// jsdom is required, not incidental: both the stub and `client.ts` use `document.cookie`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_INSTANCE_ID } from '../utils/shared/clientInstance'
import { __resetApiClientForTests, apiFetch, setSessionExpiredHandler } from './client'

// Stubbed rather than writing real cookies, so no cookie state leaks between cases.
let cookieJar = ''

function stubCookies() {
  cookieJar = ''
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookieJar,
  })
}

function restoreCookies() {
  delete (document as Partial<Document>).cookie
}

function setCsrfCookie(value: string) {
  cookieJar = `csrf_token=${encodeURIComponent(value)}`
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response
}

describe('apiFetch', () => {
  beforeEach(() => {
    stubCookies()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreCookies()
    __resetApiClientForTests()
  })

  describe('echo stamp', () => {
    it('stamps every mutation with this tab’s X-Client-Id, and no GET', async () => {
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })
      await apiFetch('/api/lists')

      const [, mutationInit] = vi.mocked(fetch).mock.calls[0]
      const [, getInit] = vi.mocked(fetch).mock.calls[1]
      // Stamped centrally so a new mutation call site cannot forget it; the SSE payload echoes
      // it back as origin_client_id, which is the whole own-echo check.
      expect(headerOf(mutationInit, 'X-Client-Id')).toBe(CLIENT_INSTANCE_ID)
      expect(headerOf(getInit, 'X-Client-Id')).toBeNull()
    })
  })

  describe('CSRF', () => {
    it('sends the X-CSRF-Token header carrying the csrf_token cookie value on mutations', async () => {
      setCsrfCookie('csrf-abc-123')
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [url, init] = vi.mocked(fetch).mock.calls[0]
      expect(url).toBe('/api/lists')
      expect(init?.credentials).toBe('include')
      // The backend CSRF guard requires the double-submit pair: csrf_token cookie plus the
      // X-CSRF-Token header. Without the header every mutation 403s.
      expect(headerOf(init, 'X-CSRF-Token')).toBe('csrf-abc-123')
    })

    it('sends the URL-decoded cookie value', async () => {
      setCsrfCookie('token/with+special=chars')
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(headerOf(init, 'X-CSRF-Token')).toBe('token/with+special=chars')
    })

    it('reads the __Host- prefixed cookie production sets', async () => {
      cookieJar = '__Host-csrf_token=prefixed-value'
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(headerOf(init, 'X-CSRF-Token')).toBe('prefixed-value')
    })

    // Both orderings, because cookie order is the browser's choice — a lookup treating the
    // prefix as optional would send whichever came first, and the stale one 403s.
    it.each([
      ['stale cookie first', 'csrf_token=stale; __Host-csrf_token=current'],
      ['prefixed cookie first', '__Host-csrf_token=current; csrf_token=stale'],
    ])('prefers the prefixed cookie over a pre-rename one (%s)', async (_label, jar) => {
      cookieJar = jar
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(headerOf(init, 'X-CSRF-Token')).toBe('current')
    })

    it('does not mistake a prefixed cookie for the unprefixed name', async () => {
      // `csrf_token=` is a suffix of `__Host-csrf_token=`, so a name match that ignores the
      // delimiter would read the prefixed cookie as the legacy one and silently pass above.
      cookieJar = '__Host-csrf_token=only-prefixed'
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(headerOf(init, 'X-CSRF-Token')).toBe('only-prefixed')
    })

    it('still sends the header (empty) when no csrf_token cookie is present', async () => {
      vi.mocked(fetch).mockResolvedValue(response(200))

      await apiFetch('/api/lists', { method: 'POST', body: '{}' })

      const [, init] = vi.mocked(fetch).mock.calls[0]
      expect(headerOf(init, 'X-CSRF-Token')).toBe('')
    })
  })

  describe('what counts as being logged out', () => {
    it('treats 401 as the session being gone', async () => {
      const expired = vi.fn()
      setSessionExpiredHandler(expired)
      vi.mocked(fetch).mockResolvedValue(response(401))

      const res = await apiFetch('/api/dashboards')

      expect(expired).toHaveBeenCalledTimes(1)
      expect(res.status).toBe(401)
    })

    // A backend restart, a Cloudflare hiccup or a dropped connection must not read as "logged
    // out": the session is still valid server-side, so a redirect to /login is wrong.
    it.each([500, 502, 503, 504, 429])('does not log the user out on %i', async (status) => {
      const expired = vi.fn()
      setSessionExpiredHandler(expired)
      vi.mocked(fetch).mockResolvedValue(response(status))

      const res = await apiFetch('/api/dashboards')

      expect(expired).not.toHaveBeenCalled()
      expect(res.status).toBe(status)
    })

    it('does not log the user out when the request never reaches the server', async () => {
      const expired = vi.fn()
      setSessionExpiredHandler(expired)
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(apiFetch('/api/dashboards')).rejects.toThrow('Failed to fetch')

      expect(expired).not.toHaveBeenCalled()
    })

    // 403 is how the permission layer answers "editor access required"; reading it as a session
    // failure would sign you out for opening someone else's dashboard.
    it('does not log the user out on 403', async () => {
      const expired = vi.fn()
      setSessionExpiredHandler(expired)
      vi.mocked(fetch).mockResolvedValue(response(403))

      const res = await apiFetch('/api/dashboards/x')

      expect(expired).not.toHaveBeenCalled()
      expect(res.status).toBe(403)
    })
  })

  describe('retries', () => {
    it('retries an idempotent request through a transient failure', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200))

      const res = await apiFetch('/api/dashboards')

      expect(res.status).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('recovers from a dropped connection', async () => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(response(200))

      const res = await apiFetch('/api/dashboards')

      expect(res.status).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('gives up after a bounded number of attempts', async () => {
      vi.mocked(fetch).mockResolvedValue(response(503))

      const res = await apiFetch('/api/dashboards')

      expect(res.status).toBe(503)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    // Nothing here carries an idempotency key, so a POST that failed may already have been
    // applied server-side. A duplicate write is a worse outcome than the error the caller sees.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never retries a %s', async (method) => {
      vi.mocked(fetch).mockResolvedValue(response(503))

      const res = await apiFetch('/api/lists', { method, body: '{}' })

      expect(res.status).toBe(503)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does not retry a 4xx, which will not change on its own', async () => {
      vi.mocked(fetch).mockResolvedValue(response(404))

      await apiFetch('/api/dashboards/missing')

      expect(fetch).toHaveBeenCalledTimes(1)
    })

    // Transient, so never a logout — but it is the server asking us to slow down, and hammering
    // it three times inside a second is the opposite of complying.
    it('does not retry a 429', async () => {
      vi.mocked(fetch).mockResolvedValue(response(429))

      const res = await apiFetch('/api/dashboards')

      expect(res.status).toBe(429)
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
})
