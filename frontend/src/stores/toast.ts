/**
 * Toast notification store
 *
 * Architecture:
 * - `useToastStore` is the Zustand store consumed by the <Toaster> component.
 * - `toast` (exported object) provides convenience helpers for use OUTSIDE
 *   React components — e.g. inside Zustand actions, API wrappers, or utilities.
 *   It calls `useToastStore.getState()` directly to bypass the React hook rules.
 *
 * Usage:
 *   // Inside a component
 *   const { toast } = useToastStore()
 *   toast('Saved!', 'success')
 *
 *   // Outside a component (e.g. in a store action)
 *   import { toast } from './toast'
 *   toast.error('Failed to save')
 *
 * Auto-dismiss: toasts disappear after 4 seconds. The user can also dismiss
 * manually via the X button in <Toaster>, which calls `dismiss(id)`.
 */
import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  type: ToastType
  message: string
}

// Module-level counter so IDs are stable across re-renders and store resets.
let _nextId = 0

const AUTO_DISMISS_MS = 4000

/**
 * Pending auto-dismiss timers, keyed by toast id.
 *
 * The handle has to stay reachable or the timer can never be cancelled: `dismiss` would drop the
 * toast from state while its timer sat on the event loop for the full 4s. That is invisible in the
 * browser, but a Vitest worker is reused across test files, so each orphaned closure keeps this
 * store — and the module graph behind it — alive long after its test file finished.
 */
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>()

function clearDismissTimer(id: number): void {
  const timer = dismissTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    dismissTimers.delete(id)
  }
}

interface ToastState {
  toasts: Toast[]
  toast: (message: string, type?: ToastType) => void
  dismiss: (id: number) => void
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  toast(message, type = 'info') {
    const id = ++_nextId
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }))
    // Schedule auto-dismiss. The closure captures `id` so only this toast is removed.
    dismissTimers.set(
      id,
      setTimeout(() => {
        dismissTimers.delete(id)
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, AUTO_DISMISS_MS),
    )
  },

  dismiss(id) {
    clearDismissTimer(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/**
 * Cancel every pending auto-dismiss and empty the store.
 *
 * Only 8 of the suite's 40 test files mock this module, so the rest arm a real 4s timer per toast
 * and then finish in milliseconds. Wired into the global `afterEach` in `test/setup*.ts`.
 */
export function __resetToastStoreForTests(): void {
  for (const timer of dismissTimers.values()) {
    clearTimeout(timer)
  }
  dismissTimers.clear()
  useToastStore.setState({ toasts: [] })
}

/**
 * Convenience helpers that bypass the hook rule — safe to call from anywhere.
 * Prefer these over `useToastStore` in non-component code (stores, utils, etc.).
 */
export const toast = {
  success: (msg: string) => useToastStore.getState().toast(msg, 'success'),
  error: (msg: string) => useToastStore.getState().toast(msg, 'error'),
  info: (msg: string) => useToastStore.getState().toast(msg, 'info'),
}
