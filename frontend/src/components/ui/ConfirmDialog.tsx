import { useEffect, useRef } from 'react'
import { useConfirmStore } from '../../stores/confirm'

export function ConfirmDialog() {
  const { open, message, _accept, _cancel } = useConfirmStore()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') _cancel()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, _cancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-xs mx-4 p-6 space-y-4">
        <p className="text-sm text-zinc-200">{message}</p>
        <div className="flex gap-2">
          <button
            ref={cancelRef}
            onClick={_cancel}
            className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={_accept}
            className="flex-1 py-2 rounded-md text-sm bg-red-600 hover:bg-red-500 text-white font-medium transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
