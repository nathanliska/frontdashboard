// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalDay } from './useLocalDay'

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
