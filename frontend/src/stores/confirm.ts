import { create } from 'zustand'

export interface ConfirmOptions {
  /** Label for the confirming button — say what it does ("Archive", "Remove"), never a generic "Delete". */
  confirmLabel?: string
  /** danger = red (destructive); default = neutral. */
  tone?: 'danger' | 'default'
}

interface ConfirmState {
  open: boolean
  message: string
  confirmLabel: string
  tone: 'danger' | 'default'
  _resolve: ((ok: boolean) => void) | null
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>
  _accept: () => void
  _cancel: () => void
  reset: () => void
}

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  open: false,
  message: '',
  confirmLabel: 'Delete',
  tone: 'danger',
  _resolve: null,

  confirm(message, options) {
    // A modal is already collecting an answer. Treat a concurrent request as
    // cancelled instead of orphaning the first caller's promise.
    if (get()._resolve) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      set({
        open: true,
        message,
        confirmLabel: options?.confirmLabel ?? 'Delete',
        tone: options?.tone ?? 'danger',
        _resolve: resolve,
      })
    })
  },

  _accept() {
    get()._resolve?.(true)
    set({ open: false, _resolve: null })
  },

  _cancel() {
    get()._resolve?.(false)
    set({ open: false, _resolve: null })
  },

  reset() {
    get()._resolve?.(false)
    set({ open: false, message: '', _resolve: null })
  },
}))

/** Convenience helper for direct imports */
export const confirm = (message: string, options?: ConfirmOptions) =>
  useConfirmStore.getState().confirm(message, options)
