import { type RefObject, useEffect, useRef, useState } from 'react'

export type ContainerSize = { width: number; height: number }

/** Never report less than this, so a mid-layout measurement cannot collapse what it sizes. */
const MIN_AVAILABLE_HEIGHT = 320

/**
 * Bottom of the content box `el` scrolls within, in viewport coordinates.
 *
 * The scrolling ancestor is the one box whose height is fixed by the layout rather than by what it
 * holds, so it is the only honest vertical bound — and stopping at its *content* box is what makes
 * the page's bottom padding count, the way `width: 100%` already makes its side padding count.
 */
function scrollableContentBottom(el: HTMLElement): number {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      const padding = Number.parseFloat(style.paddingBottom) || 0
      return Math.min(node.getBoundingClientRect().bottom - padding, window.innerHeight)
    }
  }
  return window.innerHeight
}

/**
 * Height still available below `ref` — the room a grid there can actually occupy.
 *
 * The window's own height is the wrong bound at both ends. Above, an element starting below a page
 * header has less than the window, so sizing N rows against `innerHeight` overflows by however far
 * down the element sits. Below, the page's own bottom padding is room the element may not have: an
 * element sized to the last pixel of the window sits flush against the edge while its right side
 * keeps the gutter, which is the asymmetry a reader sees first. The element's own container is no
 * help — it grows with its content and would never bind.
 */
export function useAvailableHeight(ref: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  )

  useEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) return
      const room = scrollableContentBottom(el) - el.getBoundingClientRect().top
      setHeight(Math.max(MIN_AVAILABLE_HEIGHT, room))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [ref])

  return height
}

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
