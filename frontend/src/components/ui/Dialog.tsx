import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/shared/cn'

/** The one modal shell (#27), on Radix Dialog.
 *
 * Every modal used to hand-roll its own overlay, labelling, and Escape handling — none of them
 * trapped focus, so Tab walked out into the page behind the overlay. Radix owns the focus trap,
 * scroll lock, Escape, aria-modal wiring, and focus restoration on close; this wrapper owns the
 * house style. Render it conditionally (`{open && <Dialog …>}`) like the modals always were.
 *
 * `onEscape` exists for modals with internal steps (AddWidget: Escape first backs out of a step,
 * only then closes); everything else just gets `onClose`.
 */
export function Dialog({
  title,
  onClose,
  onEscape,
  children,
  contentClassName,
  headerAccessory,
  hideHeader = false,
}: {
  title: string
  onClose: () => void
  onEscape?: () => void
  children: ReactNode
  contentClassName?: string
  headerAccessory?: ReactNode
  hideHeader?: boolean
}) {
  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <RadixDialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={
            onEscape
              ? (event) => {
                  event.preventDefault()
                  onEscape()
                }
              : undefined
          }
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2',
            'max-h-[85vh] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl',
            'px-0 focus:outline-none',
            contentClassName,
          )}
        >
          {hideHeader ? (
            // Modals that draw their own chrome still need an accessible name.
            <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          ) : (
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-5 py-4">
              <div className="flex min-w-0 items-center gap-2">
                {headerAccessory}
                <RadixDialog.Title className="truncate text-sm font-semibold text-zinc-100">
                  {title}
                </RadixDialog.Title>
              </div>
              <RadixDialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close dialog"
                  className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-200"
                >
                  <X size={15} />
                </button>
              </RadixDialog.Close>
            </div>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
