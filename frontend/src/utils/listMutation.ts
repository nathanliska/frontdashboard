export { createClientMutationId } from './clientMutation'

const pendingListMutationIds = new Map<string, number>()
const LIST_MUTATION_ECHO_TTL_MS = 5000

function pruneExpiredPendingListMutations(now = Date.now()): void {
  for (const [clientMutationId, expiresAt] of pendingListMutationIds) {
    if (expiresAt <= now) {
      pendingListMutationIds.delete(clientMutationId)
    }
  }
}
export function recordPendingListMutation(clientMutationId: string): void {
  pruneExpiredPendingListMutations()
  pendingListMutationIds.set(clientMutationId, Date.now() + LIST_MUTATION_ECHO_TTL_MS)
}

export function forgetPendingListMutation(clientMutationId: string): void {
  pendingListMutationIds.delete(clientMutationId)
}

export function consumePendingListMutation(clientMutationId: string): boolean {
  pruneExpiredPendingListMutations()
  if (!pendingListMutationIds.has(clientMutationId)) return false

  pendingListMutationIds.delete(clientMutationId)
  return true
}

export function __resetPendingListMutationsForTests(): void {
  pendingListMutationIds.clear()
}
