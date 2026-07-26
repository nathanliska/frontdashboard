import { useEffect } from 'react'
import { useConfirmStore } from '../../stores/confirm'
import { cn } from '../../utils/shared/cn'
import { Dialog } from './Dialog'

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const message = useConfirmStore((s) => s.message)
  const confirmLabel = useConfirmStore((s) => s.confirmLabel)
  const tone = useConfirmStore((s) => s.tone)
  const _accept = useConfirmStore((s) => s._accept)
  const _cancel = useConfirmStore((s) => s._cancel)

  useEffect(() => () => useConfirmStore.getState().reset(), [])

  if (!open) return null

  return (
    <Dialog title={message} onClose={_cancel} hideHeader contentClassName="max-w-xs">
      <div className="space-y-4 p-6">
        <p className="text-sm text-zinc-200">{message}</p>
        <div className="flex gap-2">
          {/* Cancel first in the DOM: Radix focuses the first focusable, so the safe action is
              the default — Enter on open cancels, it never destroys. */}
          <button
            type="button"
            onClick={_cancel}
            className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={_accept}
            className={cn(
              'flex-1 py-2 rounded-md text-sm font-medium transition-colors',
              tone === 'danger'
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-zinc-100 hover:bg-white text-zinc-900',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
