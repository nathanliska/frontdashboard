import { useEffect, useRef } from 'react'
import { useConfirmStore } from '../../stores/confirm'

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const message = useConfirmStore((s) => s.message)
  const _accept = useConfirmStore((s) => s._accept)
  const _cancel = useConfirmStore((s) => s._cancel)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-200 flex items-center justify-center bg-black/50"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          _cancel()
        }
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-xs mx-4 p-6 space-y-4">
        <p className="text-sm text-zinc-200">{message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={_cancel}
            className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
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
