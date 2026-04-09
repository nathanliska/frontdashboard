import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetDashboard, apiGetDashboardShares } from './dashboards'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('./client', () => ({
  apiFetch,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('dashboard api request dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dedupes in-flight dashboard detail reads', async () => {
    const response = {
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 'dash-1', name: 'Primary Dashboard' }),
    }
    const request = deferred<typeof response>()
    apiFetch.mockReturnValue(request.promise)

    const first = apiGetDashboard('dash-1')
    const second = apiGetDashboard('dash-1')

    expect(apiFetch).toHaveBeenCalledTimes(1)

    request.resolve(response)
    await expect(first).resolves.toMatchObject({ id: 'dash-1' })
    await expect(second).resolves.toMatchObject({ id: 'dash-1' })
  })

  it('dedupes in-flight dashboard share reads', async () => {
    const response = {
      ok: true,
      json: vi.fn().mockResolvedValue([{ id: 'share-1', principal_name: 'Viewer One' }]),
    }
    const request = deferred<typeof response>()
    apiFetch.mockReturnValue(request.promise)

    const first = apiGetDashboardShares('dash-1')
    const second = apiGetDashboardShares('dash-1')

    expect(apiFetch).toHaveBeenCalledTimes(1)

    request.resolve(response)
    await expect(first).resolves.toMatchObject([{ id: 'share-1' }])
    await expect(second).resolves.toMatchObject([{ id: 'share-1' }])
  })
})
