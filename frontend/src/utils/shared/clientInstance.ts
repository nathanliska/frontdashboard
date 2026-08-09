import type { SseEvent } from '../../hooks/useSSE'

function generateClientInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * This tab's identity for echo suppression, minted once per page load. Every mutation carries it
 * (`X-Client-Id`, stamped centrally in `apiFetch`) and the SSE payload echoes it back as
 * `origin_client_id`, so frames this tab caused are recognizable without per-mutation bookkeeping.
 */
export const CLIENT_INSTANCE_ID = generateClientInstanceId()

/**
 * True when the frame echoes a write this tab issued — its response is the state already applied.
 * The actor check is defense in depth: the instance id alone is already unguessably unique.
 */
export function isOwnFrame(event: SseEvent, userId: string | null | undefined): boolean {
  if (!userId || event.actor_id !== userId) return false
  return (event.payload.origin_client_id ?? null) === CLIENT_INSTANCE_ID
}
