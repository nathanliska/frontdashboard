import type { ReactNode } from 'react'
import { Dialog } from '../ui/Dialog'

/**
 * The event editor's modal shell: a bottom sheet on a phone, a centred panel above `sm`.
 *
 * The editor draws its own header, so the dialog's is hidden and `title` survives only as the
 * accessible name. Scrolling is the inner region's rather than the panel's, which keeps the drag
 * handle in place while a long repeat configuration scrolls under it.
 */
export function CalendarEditorDialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      hideHeader
      placement="sheet"
      contentClassName="sm:max-w-4xl"
    >
      <div className="flex justify-center pb-1 pt-3 sm:hidden">
        <div className="h-1 w-12 rounded-full bg-zinc-600" />
      </div>
      <div className="max-h-[85vh] overflow-y-auto">{children}</div>
    </Dialog>
  )
}
