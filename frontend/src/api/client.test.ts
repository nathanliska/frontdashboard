// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tryRefresh } from './client'

// Stub the cookie getter rather than writing real cookies: keeps each test
// hermetic (no cookie state leaking between cases) and mirrors how the browser
// exposes the httponly=False csrf_token cookie to JS.
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

describe('tryRefresh', () => {
  beforeEach(() => {
    stubCookies()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    restoreCookies()
  })

  it('sends the X-CSRF-Token header carrying the csrf_token cookie value', async () => {
    setCsrfCookie('csrf-abc-123')
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)

    await expect(tryRefresh()).resolves.toBe('refreshed')

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('/api/auth/refresh')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('include')
    // The backend CSRF guard (finding #44) requires the double-submit pair:
    // csrf_token cookie + X-CSRF-Token header. Without the header refresh 403s
    // and every session dies at the access-token TTL.
    expect(headerOf(init, 'X-CSRF-Token')).toBe('csrf-abc-123')
  })

  it('sends the URL-decoded cookie value', async () => {
    setCsrfCookie('token/with+special=chars')
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)

    await tryRefresh()

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(headerOf(init, 'X-CSRF-Token')).toBe('token/with+special=chars')
  })

  it('still sends the header (empty) when no csrf_token cookie is present', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)

    await expect(tryRefresh()).resolves.toBe('unauthorized')

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(headerOf(init, 'X-CSRF-Token')).toBe('')
  })

  it('resolves unauthorized when refresh rejects', async () => {
    setCsrfCookie('csrf-abc-123')
    vi.mocked(fetch).mockRejectedValue(new Error('network down'))

    await expect(tryRefresh()).resolves.toBe('unauthorized')
  })

  it('reports rate-limited on 429 so callers do not log the user out', async () => {
    // A burst of tabs can exhaust the /refresh rate limit; a 429 is transient and
    // must NOT be treated as a lost session.
    setCsrfCookie('csrf-abc-123')
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 429 } as Response)

    await expect(tryRefresh()).resolves.toBe('rate-limited')
  })

  it('single-flights concurrent refreshes into one request', async () => {
    setCsrfCookie('csrf-abc-123')
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)

    const [a, b] = await Promise.all([tryRefresh(), tryRefresh()])

    expect(a).toBe('refreshed')
    expect(b).toBe('refreshed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
