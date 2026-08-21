// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ContainerSize, useAvailableHeight, useContainerSize } from './useContainerSize'

type Entry = { contentRect: { width: number; height: number } }
let emit: ((entries: Entry[]) => void) | null = null
const realResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  emit = null
  globalThis.ResizeObserver = class {
    constructor(callback: (entries: Entry[]) => void) {
      emit = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver
})

function Probe({ onSize }: { onSize?: (size: ContainerSize) => void }) {
  const [ref, size] = useContainerSize({ width: 300, height: 320 })
  onSize?.(size)
  return (
    <div ref={ref} data-testid="box">
      {size.width}x{size.height}
    </div>
  )
}

function resizeTo(width: number, height: number) {
  act(() => emit?.([{ contentRect: { width, height } }]))
}

describe('useContainerSize', () => {
  it('renders the initial size until the observer first reports', () => {
    // The first callback lands after paint, so this value is what the user actually sees first
    // rather than a placeholder — a zero here would paint the smallest layout, then snap.
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('box')).toHaveTextContent('300x320')
  })

  it('reports both axes from one observation', () => {
    const { getByTestId } = render(<Probe />)
    resizeTo(180, 140)
    expect(getByTestId('box')).toHaveTextContent('180x140')
  })

  it('hands back the same object when the reported size is unchanged', () => {
    const seen: ContainerSize[] = []
    render(<Probe onSize={(size) => seen.push(size)} />)

    resizeTo(180, 140)
    const afterChange = seen.at(-1)

    resizeTo(180, 140)
    resizeTo(180, 140)

    // Identity, not equality: consumers put this in dependency arrays, so a fresh object per
    // observation would re-run their effects throughout a drag that changed nothing. Asserting on
    // a render count instead would be testing React's bailout, which is not a guarantee.
    expect(seen.at(-1)).toBe(afterChange)
    expect(new Set(seen.map((size) => `${size.width}x${size.height}`)).size).toBe(2)
  })
})

// jsdom lays nothing out, so the page shape a measurement reads has to be stated outright: a
// scrolling `main` padded on every side, with the measured element starting below a header.
function measurePage({
  windowHeight,
  scrollerBottom,
  paddingBottom,
  elementTop,
}: {
  windowHeight: number
  scrollerBottom: number
  paddingBottom: string
  elementTop: number
}): number {
  Object.defineProperty(window, 'innerHeight', { value: windowHeight, configurable: true })

  const stubRect = (bottom: number, top: number) => (node: HTMLDivElement | null) => {
    // Callback refs run in the commit phase, before the effect that measures — so the stub is in
    // place by the time the hook reads it, without a second render to force.
    if (node) node.getBoundingClientRect = () => ({ top, bottom }) as DOMRect
  }

  let measured = 0
  function Probe() {
    const ref = useRef<HTMLDivElement>(null)
    measured = useAvailableHeight(ref)
    return (
      <div style={{ overflowY: 'auto', paddingBottom }} ref={stubRect(scrollerBottom, 0)}>
        <div
          ref={(node) => {
            stubRect(elementTop, elementTop)(node)
            ref.current = node
          }}
        />
      </div>
    )
  }

  render(<Probe />)
  return measured
}

describe('useAvailableHeight', () => {
  it('leaves the page its bottom padding, the way the horizontal axis already does', () => {
    // A grid sized to the last pixel of the window sits flush against the edge while its right
    // side keeps the gutter — the asymmetry a reader notices first. Room ends at the scrolling
    // container's *content* box, so the 24px of `p-6` counts on the bottom as it does on the side.
    expect(
      measurePage({
        windowHeight: 1300,
        scrollerBottom: 1300,
        paddingBottom: '24px',
        elementTop: 80,
      }),
    ).toBe(1300 - 24 - 80)
  })

  it('never reports more room than the window has', () => {
    // An unclamped scroller can extend past the fold. Room the user must scroll to reach is not
    // room something claiming to fit the screen may spend.
    expect(
      measurePage({
        windowHeight: 1000,
        scrollerBottom: 2400,
        paddingBottom: '24px',
        elementTop: 80,
      }),
    ).toBe(1000 - 80)
  })
})
