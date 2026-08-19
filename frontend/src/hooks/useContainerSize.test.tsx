// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ContainerSize, useContainerSize } from './useContainerSize'

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
