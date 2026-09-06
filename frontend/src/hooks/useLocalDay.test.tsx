// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalDay, useLocalToday } from './useLocalDay'

describe('useLocalDay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances the day key when the clock crosses local midnight', () => {
    vi.setSystemTime(new Date(2026, 6, 19, 23, 59, 0)) // Jul 19, 23:59 local
    const { result } = renderHook(() => useLocalDay())
    expect(result.current).toBe('2026-07-19')

    act(() => {
      // Past midnight into Jul 20; run the scheduled timeout.
      vi.advanceTimersByTime(2 * 60 * 1000)
    })
    expect(result.current).toBe('2026-07-20')
  })

  it('re-syncs when a backgrounded tab becomes visible after midnight', () => {
    vi.setSystemTime(new Date(2026, 6, 19, 12, 0, 0))
    const { result } = renderHook(() => useLocalDay())
    expect(result.current).toBe('2026-07-19')

    // Simulate a slept-through midnight: jump the clock, then the tab wakes.
    vi.setSystemTime(new Date(2026, 6, 21, 8, 0, 0))
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-07-21')
  })

  it('does not change on a focus event within the same day', () => {
    vi.setSystemTime(new Date(2026, 6, 19, 9, 0, 0))
    const { result } = renderHook(() => useLocalDay())
    const before = result.current

    act(() => {
      vi.setSystemTime(new Date(2026, 6, 19, 17, 0, 0)) // later, same day
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current).toBe(before)
    expect(result.current).toBe('2026-07-19')
  })
})

describe('useLocalToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is local midnight of the current day, not the current instant', () => {
    vi.setSystemTime(new Date(2026, 6, 19, 17, 42, 30))
    const { result } = renderHook(() => useLocalToday())

    expect(result.current.getFullYear()).toBe(2026)
    expect(result.current.getMonth()).toBe(6)
    expect(result.current.getDate()).toBe(19)
    expect(result.current.getHours()).toBe(0)
    expect(result.current.getMinutes()).toBe(0)
  })

  it('holds one identity through the day and takes a new one at the rollover', () => {
    // Identity, not value: callers put this in dependency arrays, and a fresh Date per render
    // would re-run their effects every render while every assertion on the date still passed.
    vi.setSystemTime(new Date(2026, 6, 19, 23, 59, 0))
    const { result, rerender } = renderHook(() => useLocalToday())
    const first = result.current

    rerender()
    expect(result.current).toBe(first)

    act(() => {
      window.dispatchEvent(new Event('focus')) // same day, so nothing moves
    })
    expect(result.current).toBe(first)

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // past midnight into Jul 20
    })
    expect(result.current).not.toBe(first)
    expect(result.current.getDate()).toBe(20)
  })
})
