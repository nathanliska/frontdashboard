import { vi } from 'vitest'

/**
 * Make every observed element report `size` as soon as it is observed.
 *
 * The setup's stub never reports, so a component measuring itself keeps its initial size; this
 * stands in for the one measurement a test wants to drive. Undo with `vi.unstubAllGlobals()`.
 */
export function stubResizeObserver(size: { width: number; height: number }) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      report: ResizeObserverCallback
      constructor(report: ResizeObserverCallback) {
        this.report = report
      }
      observe() {
        this.report([{ contentRect: size } as never], this as never)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
  )
}
