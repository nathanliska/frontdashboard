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
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 4000)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/**
 * Convenience helpers that bypass the hook rule — safe to call from anywhere.
 * Prefer these over `useToastStore` in non-component code (stores, utils, etc.).
 */
export const toast = {
  success: (msg: string) => useToastStore.getState().toast(msg, 'success'),
  error: (msg: string) => useToastStore.getState().toast(msg, 'error'),
  info: (msg: string) => useToastStore.getState().toast(msg, 'info'),
}
