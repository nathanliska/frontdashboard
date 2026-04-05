import { create } from 'zustand'

interface ConfirmState {
  open: boolean
  message: string
  _resolve: ((ok: boolean) => void) | null
  confirm: (message: string) => Promise<boolean>
  _accept: () => void
  _cancel: () => void
}

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  open: false,
  message: '',
  _resolve: null,

  confirm(message) {
    return new Promise<boolean>((resolve) => {
      set({ open: true, message, _resolve: resolve })
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
}))

/** Convenience helper for direct imports */
export const confirm = (message: string) => useConfirmStore.getState().confirm(message)
