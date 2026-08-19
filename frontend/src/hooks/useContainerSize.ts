import { useEffect, useRef, useState } from 'react'

export type ContainerSize = { width: number; height: number }

/**
 * Measure an element's content box, for layout that answers to its own size, not the viewport's.
 *
 * Reach for a CSS container query first. This is for the decisions CSS cannot express — how many
 * rows fit, which label set to render — not for spacing or type scale, which belong in `@container`
 * and cost no render.
 *
 * `initial` stands in until the observer's first callback, which lands after the first paint, so
 * it decides what that paint shows rather than being a throwaway. Pass the size the element
 * usually has; zero renders a frame of the smallest layout before snapping out of it.
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>(initial: ContainerSize) {
  const ref = useRef<T>(null)
  const [size, setSize] = useState(initial)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      // The same object back unless a number moved. Callers put this in dependency arrays, and a
      // grid drag reports continuously — a fresh object per observation re-runs their effects for
      // a size that never changed.
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      )
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}
