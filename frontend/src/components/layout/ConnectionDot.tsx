import { isConnectionDegraded, useConnectionStore } from '../../stores/connection'
import { cn } from '../../utils/shared/cn'

/**
 * Marks a stream that has stopped delivering, wherever the account chrome is.
 *
 * Renders nothing while healthy: an indicator that is present all day stops being read. Purely
 * decorative — each host owns the accessible wording, because it depends on the control the dot
 * is attached to. Positioning is the caller's too, since the anchor differs per surface.
 */
export function ConnectionDot({ className }: { className?: string }) {
  const status = useConnectionStore((s) => s.status)
  if (!isConnectionDegraded(status)) return null

  return (
    <span
      aria-hidden="true"
      className={cn('absolute w-2 h-2 rounded-full bg-amber-500 ring-2 ring-zinc-950', className)}
    />
  )
}
