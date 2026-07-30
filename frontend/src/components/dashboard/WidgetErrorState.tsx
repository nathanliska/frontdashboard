/** Shared failure state for widget bodies: says what failed and offers a way out.
 *
 * Pass `onRetry` for transient failures (network, 5xx) — an error state without an affordance
 * turns an outage into what looks like data loss. Omit it when retrying cannot help (the bound
 * resource is gone), where the copy should say so instead.
 */
export function WidgetErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string
  detail: string
  onRetry?: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1">
      <p className="text-xs text-zinc-600">{title}</p>
      <p className="text-[10px] text-zinc-700">{detail}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
        >
          Try again
        </button>
      )}
    </div>
  )
}
