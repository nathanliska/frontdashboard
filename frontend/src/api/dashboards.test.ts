import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetDashboard, apiGetDashboardShares, apiListDashboards } from './dashboards'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('./client', () => ({
  apiFetch,
}))

// Real UUIDs because the generated contract validates the format; a placeholder here would fail
// the boundary for a reason that has nothing to do with what these tests assert.
const DASHBOARD_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const VIEWER_ID = '33333333-3333-4333-8333-333333333333'
const SHARE_ID = '44444444-4444-4444-8444-444444444444'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('dashboard share request dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dedupes in-flight dashboard share reads', async () => {
    const response = {
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          id: SHARE_ID,
          resource_type: 'dashboard',
          resource_id: DASHBOARD_ID,
          principal_type: 'user',
          principal_id: VIEWER_ID,
          principal_name: 'Viewer One',
          role: 'viewer',
          granted_by: OWNER_ID,
          created_at: '2026-01-01T00:00:00Z',
        },
      ]),
    }
    const request = deferred<typeof response>()
    apiFetch.mockReturnValue(request.promise)

    const first = apiGetDashboardShares(DASHBOARD_ID)
    const second = apiGetDashboardShares(DASHBOARD_ID)

    expect(apiFetch).toHaveBeenCalledTimes(1)

    request.resolve(response)
    await expect(first).resolves.toMatchObject([{ id: SHARE_ID }])
    await expect(second).resolves.toMatchObject([{ id: SHARE_ID }])
  })
})

describe('response boundary validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const validSummary = {
    id: DASHBOARD_ID,
    user_id: OWNER_ID,
    name: 'Primary Dashboard',
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
