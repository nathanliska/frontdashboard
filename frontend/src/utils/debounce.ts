/**
 * Coalesce a burst of requests into one call, resolving every caller with its result.
 *
 * Callers await the same promise, so a refresh triggered five times runs once and settles all
 * five. `cancel` settles a pending promise before dropping it — a caller awaiting one across a
 * sign-out would otherwise hang forever, since nothing is left to run it.
 */
export type DebouncedRefresh = {
  schedule: (run: () => Promise<void>) => Promise<void>
  cancel: () => void
}

export function createDebouncedRefresh(delayMs: number): DebouncedRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null
  let promise: Promise<void> | null = null
  let resolveOne: (() => void) | null = null
  let rejectOne: ((error: unknown) => void) | null = null

  return {
    schedule(run) {
      if (!promise) {
        promise = new Promise<void>((resolve, reject) => {
          resolveOne = resolve
          rejectOne = reject
        })
      }
      if (timer) clearTimeout(timer)

      timer = setTimeout(() => {
        timer = null
        const resolve = resolveOne
        const reject = rejectOne
        promise = null
        resolveOne = null
        rejectOne = null
        void run().then(
          () => resolve?.(),
          (error) => reject?.(error),
        )
      }, delayMs)

      return promise
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      resolveOne?.()
      promise = null
      resolveOne = null
      rejectOne = null
    },
  }
}
