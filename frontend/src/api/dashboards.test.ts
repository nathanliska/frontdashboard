import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetDashboard, apiGetDashboardShares, apiListDashboards } from './dashboards'

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
      json: vi.fn().mockResolvedValue({
        id: 'dash-1',
        user_id: 'user-1',
        name: 'Primary Dashboard',
        archived: false,
        can_edit: true,
        can_manage_shares: true,
        is_favorite: false,
        is_shared: false,
        layout: [],
        version: 1,
        widgets: [],
      }),
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
      json: vi.fn().mockResolvedValue([
        {
          id: 'share-1',
          resource_type: 'dashboard',
          resource_id: 'dash-1',
          principal_type: 'user',
          principal_id: 'user-2',
          principal_name: 'Viewer One',
          role: 'viewer',
          granted_by: 'user-1',
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
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

describe('response boundary validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const validSummary = {
    id: 'dash-1',
    user_id: 'user-1',
    name: 'Primary Dashboard',
    archived: false,
    can_edit: true,
    can_manage_shares: true,
    is_favorite: false,
    is_shared: false,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  it('rejects with an ApiError when a list response is missing a required field', async () => {
    const { version: _version, ...summaryMissingVersion } = validSummary
    apiFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([summaryMissingVersion]),
    })

    await expect(apiListDashboards()).rejects.toMatchObject({ name: 'ApiError' })
  })

  it('resolves typed data when a list response matches the schema', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([validSummary]),
    })

    await expect(apiListDashboards()).resolves.toEqual([validSummary])
  })

  it('rejects with an ApiError when an object response is missing a required field', async () => {
    const { widgets: _widgets, ...dashboardMissingWidgets } = {
      ...validSummary,
      layout: [],
      widgets: [],
    }
    apiFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(dashboardMissingWidgets),
    })

    await expect(apiGetDashboard('dash-missing-widgets')).rejects.toMatchObject({
      name: 'ApiError',
    })
  })
})
