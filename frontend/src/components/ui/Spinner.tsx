/**
 * The app's loading indicators.
 *
 * Two of them, because a page load has exactly two states worth distinguishing: before the shell
 * can be drawn at all, and after. Anything more moves the indicator around mid-load, which reads
 * as the page loading twice.
 */

function Spinner({ className }: { className: string }) {
  return (
    <div
      className={`animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400 ${className}`}
    />
  )
}

/**
 * Covers the viewport while the session is being resolved.
 *
 * Only for the pre-shell boot: nothing is known yet, so there is no content area to fill.
 * The spinner waits the same beat as LoadingBlock's — a fast boot shows only the app
 * background, which index.html already painted.
 */
export function LoadingScreen({ label }: { label: string }) {
  return (
    <div
      className="flex h-screen items-center justify-center bg-zinc-950"
      role="status"
      aria-label={label}
    >
      <div className="loading-appear">
        <Spinner className="h-8 w-8" />
      </div>
    </div>
  )
}

/**
 * Fills the content area while a route chunk or a page's data loads.
 *
 * Used by the router's Suspense fallback and by pages, so the indicator stays put as one hands
 * over to the other. The spinner fades in only after a beat (see .loading-appear), so a load
 * that finishes fast never flashes an indicator; screen readers are told immediately.
 */
export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-64 items-center justify-center" role="status" aria-label={label}>
      {/* Wrapper carries the fade so animate-spin keeps the spinner's animation property. */}
      <div className="loading-appear">
        <Spinner className="h-5 w-5" />
      </div>
    </div>
  )
}
