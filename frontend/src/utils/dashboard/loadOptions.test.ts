import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginDashboardRequest,
  dashboardLoadSatisfiesRequest,
  isLatestDashboardRequest,
  mergeDashboardLoadOptions,
  normalizeDashboardLoadOptions,
  resetDashboardRequests,
} from './loadOptions'

const FOREGROUND = { background: false, surfaceAccessLoss: false }
const BACKGROUND = { background: true, surfaceAccessLoss: false }

describe('normalizing', () => {
  it('defaults both flags to false', () => {
    expect(normalizeDashboardLoadOptions()).toEqual(FOREGROUND)
    expect(normalizeDashboardLoadOptions({ background: true })).toEqual(BACKGROUND)
  })
})

describe('merging two overlapping requests', () => {
  it('narrows background — one foreground caller makes the whole load foreground', () => {
    expect(mergeDashboardLoadOptions(BACKGROUND, FOREGROUND).background).toBe(false)
    expect(mergeDashboardLoadOptions(BACKGROUND, BACKGROUND).background).toBe(true)
  })

  it('widens surfaceAccessLoss — one caller wanting the error gets it', () => {
    expect(
      mergeDashboardLoadOptions(FOREGROUND, { background: false, surfaceAccessLoss: true })
        .surfaceAccessLoss,
    ).toBe(true)
    expect(
      mergeDashboardLoadOptions({ background: false, surfaceAccessLoss: true }, FOREGROUND)
        .surfaceAccessLoss,
    ).toBe(true)
  })

  it('takes the incoming options when there is nothing in flight', () => {
    expect(mergeDashboardLoadOptions(null, BACKGROUND)).toEqual(BACKGROUND)
  })
})

describe('whether an in-flight load already covers a request', () => {
  it('a foreground load satisfies a background request', () => {
    expect(dashboardLoadSatisfiesRequest(FOREGROUND, BACKGROUND)).toBe(true)
  })

  it('a background load does not satisfy a foreground request', () => {
    expect(dashboardLoadSatisfiesRequest(BACKGROUND, FOREGROUND)).toBe(false)
  })

  it('a load not surfacing access loss cannot satisfy one that needs it', () => {
    expect(
      dashboardLoadSatisfiesRequest(FOREGROUND, { background: false, surfaceAccessLoss: true }),
    ).toBe(false)
    expect(
      dashboardLoadSatisfiesRequest({ background: false, surfaceAccessLoss: true }, FOREGROUND),
    ).toBe(true)
  })
})

describe('request serials', () => {
  beforeEach(resetDashboardRequests)

  it('only the newest request for an id is latest', () => {
    const first = beginDashboardRequest('dash-1')
    expect(isLatestDashboardRequest('dash-1', first)).toBe(true)

    const second = beginDashboardRequest('dash-1')
    // Two loads of the *same* dashboard: the id alone cannot tell them apart, which is why the
    // serial exists — an abandoned response must not write itself into the store.
    expect(isLatestDashboardRequest('dash-1', first)).toBe(false)
    expect(isLatestDashboardRequest('dash-1', second)).toBe(true)
  })

  it('navigating to another dashboard invalidates the previous one', () => {
    const first = beginDashboardRequest('dash-1')
    beginDashboardRequest('dash-2')
    expect(isLatestDashboardRequest('dash-1', first)).toBe(false)
  })

  it('serials keep climbing across ids, so one never collides with another', () => {
    const a = beginDashboardRequest('dash-1')
    const b = beginDashboardRequest('dash-2')
    expect(b).toBeGreaterThan(a)
  })

  it('matches on the id too, not the serial alone', () => {
    // Unreachable through the store, which only ever asks about the id it loaded — but the serial
    // is not a global identity, and a check that ignored the id would say yes to any dashboard.
    const serial = beginDashboardRequest('dash-1')
    expect(isLatestDashboardRequest('dash-2', serial)).toBe(false)
  })

  it('a reset drops the claim, so a response landing after sign-out is not latest', () => {
    const serial = beginDashboardRequest('dash-1')
    resetDashboardRequests()
    expect(isLatestDashboardRequest('dash-1', serial)).toBe(false)
  })
})
