/**
 * Reconciling overlapping `loadDashboard` requests.
 *
 * Two callers can ask for the same dashboard with different intent — a background SSE-driven
 * refresh and a foreground navigation — and the in-flight one has to answer both or neither. The
 * merge is asymmetric on purpose: `background` narrows (any foreground caller makes the load
 * foreground), `surfaceAccessLoss` widens (any caller wanting the error surfaced gets it).
 */
export type LoadDashboardOptions = {
  background?: boolean
  surfaceAccessLoss?: boolean
}

export type NormalizedLoadDashboardOptions = {
  background: boolean
  surfaceAccessLoss: boolean
}

let latestDashboardRequest: { id: string; serial: number } | null = null

export function normalizeDashboardLoadOptions(
  options: LoadDashboardOptions = {},
): NormalizedLoadDashboardOptions {
  return {
    background: options.background ?? false,
    surfaceAccessLoss: options.surfaceAccessLoss ?? false,
  }
}

export function mergeDashboardLoadOptions(
  current: NormalizedLoadDashboardOptions | null,
  next: NormalizedLoadDashboardOptions,
): NormalizedLoadDashboardOptions {
  if (!current) return next
  return {
    background: current.background && next.background,
    surfaceAccessLoss: current.surfaceAccessLoss || next.surfaceAccessLoss,
  }
}

/** True when an in-flight load already does everything the new request wanted. */
export function dashboardLoadSatisfiesRequest(
  current: NormalizedLoadDashboardOptions,
  requested: NormalizedLoadDashboardOptions,
): boolean {
  return (
    (requested.background || !current.background) &&
    (!requested.surfaceAccessLoss || current.surfaceAccessLoss)
  )
}

/**
 * Claim the newest request for a dashboard, returning the serial that identifies it.
 *
 * Navigating away mid-load must not let the abandoned response write itself into the store, and
 * the id alone cannot tell two loads of the *same* dashboard apart.
 */
export function beginDashboardRequest(id: string): number {
  const serial = (latestDashboardRequest?.serial ?? 0) + 1
  latestDashboardRequest = { id, serial }
  return serial
}

export function isLatestDashboardRequest(id: string, serial: number): boolean {
  return latestDashboardRequest?.id === id && latestDashboardRequest.serial === serial
}

export function resetDashboardRequests(): void {
  latestDashboardRequest = null
}
