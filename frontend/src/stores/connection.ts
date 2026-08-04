import { create } from 'zustand'

/**
 * Liveness of the one SSE stream, so the UI can admit when it has stopped listening.
 *
 * Deliberately not a presence badge: this is *your* stream, not who else is online. And it is only
 * ever drawn while degraded — a dot that is green all day stops being read, and the failure this
 * exists for is the app looking live while receiving nothing.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting'

interface ConnectionState {
  status: ConnectionStatus
  setConnectionStatus: (status: ConnectionStatus) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'connecting',
  setConnectionStatus: (status) => set({ status }),
}))

/** True while the stream is down and retrying — the only state worth showing. */
export function isConnectionDegraded(status: ConnectionStatus): boolean {
  return status === 'reconnecting'
}

export function __resetConnectionStoreForTests(): void {
  useConnectionStore.setState({ status: 'connecting' })
}
