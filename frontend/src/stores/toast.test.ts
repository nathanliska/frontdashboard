import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetToastStoreForTests, toast, useToastStore } from './toast'

const AUTO_DISMISS_MS = 4000

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetToastStoreForTests()
  })

  afterEach(() => {
    __resetToastStoreForTests()
    vi.useRealTimers()
  })

  it('auto-dismisses a toast once the timeout elapses', () => {
    toast.info('Saved')
    expect(useToastStore.getState().toasts).toHaveLength(1)

    vi.advanceTimersByTime(AUTO_DISMISS_MS)

    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the pending auto-dismiss when a toast is dismissed by hand', () => {
    toast.error('Failed to save')
    const [{ id }] = useToastStore.getState().toasts
    expect(vi.getTimerCount()).toBe(1)

    useToastStore.getState().dismiss(id)

    // The defect this pins: the auto-dismiss handle was never captured, so `dismiss` removed the
    // toast from state but had no way to cancel its timer. The callback stayed queued for the full
    // 4s holding the store in its closure — harmless in a browser, but a Vitest worker is reused
    // across files, so every orphaned timer kept a whole module graph reachable.
    expect(vi.getTimerCount()).toBe(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('leaves other toasts and their timers alone when one is dismissed', () => {
    toast.info('first')
    toast.info('second')
    const [first] = useToastStore.getState().toasts

    useToastStore.getState().dismiss(first.id)

    expect(vi.getTimerCount()).toBe(1)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['second'])
  })

  it('cancels every pending timer on reset', () => {
    toast.info('one')
    toast.success('two')
    expect(vi.getTimerCount()).toBe(2)

    __resetToastStoreForTests()

    expect(vi.getTimerCount()).toBe(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
