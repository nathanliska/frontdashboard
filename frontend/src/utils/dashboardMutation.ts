export { createClientMutationId } from './clientMutation'

const pendingDashboardMutationIds = new Map<string, number>()
const DASHBOARD_MUTATION_ECHO_TTL_MS = 5000

function pruneExpiredPendingDashboardMutations(now = Date.now()): void {
  for (const [clientMutationId, expiresAt] of pendingDashboardMutationIds) {
    if (expiresAt <= now) {
      pendingDashboardMutationIds.delete(clientMutationId)
    }
  }
}

export function recordPendingDashboardMutation(clientMutationId: string): void {
  pruneExpiredPendingDashboardMutations()
  pendingDashboardMutationIds.set(clientMutationId, Date.now() + DASHBOARD_MUTATION_ECHO_TTL_MS)
}

export function forgetPendingDashboardMutation(clientMutationId: string): void {
  pendingDashboardMutationIds.delete(clientMutationId)
}

export function consumePendingDashboardMutation(clientMutationId: string): boolean {
  pruneExpiredPendingDashboardMutations()
  if (!pendingDashboardMutationIds.has(clientMutationId)) return false

  pendingDashboardMutationIds.delete(clientMutationId)
  return true
}

export function __resetPendingDashboardMutationsForTests(): void {
  pendingDashboardMutationIds.clear()
}
