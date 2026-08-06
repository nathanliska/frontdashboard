import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/shared/cn'

/** Where the panel sits. `sheet` docks it to the bottom edge below `sm` and centres it above.
 *
 * The two are exclusive branches rather than overrides because `cn` joins rather than merges, so a
 * caller's `left-0` and this file's `left-1/2` would both apply and stylesheet order would decide.
 */
const PLACEMENT = {
  center: 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl',
  sheet:
    'inset-x-0 bottom-0 rounded-t-2xl sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
} as const

/** The one modal shell, on Radix Dialog.
 *
 * Radix owns the focus trap, scroll lock, Escape, hiding the page behind it and restoring focus;
 * this wrapper owns the house style. A hand-rolled overlay does not trap focus, so Tab walks out
 * into the page behind it. Render conditionally (`{open && <Dialog …>}`).
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
  placement = 'center',
}: {
  title: string
  onClose: () => void
  onEscape?: () => void
  children: ReactNode
  contentClassName?: string
  headerAccessory?: ReactNode
  hideHeader?: boolean
  placement?: keyof typeof PLACEMENT
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
            'fixed z-50 w-full max-w-2xl',
            PLACEMENT[placement],
            'max-h-[85vh] overflow-hidden border border-zinc-800 bg-zinc-900 shadow-2xl',
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
