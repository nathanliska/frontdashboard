// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from './ui'

beforeEach(() => {
  useUIStore.setState({ sidebarCollapsed: false, mobileSidebarOpen: false })
  localStorage.clear()
})

describe('ui store persistence', () => {
  it('persists only the durable sidebar preference', () => {
    useUIStore.setState({ sidebarCollapsed: true, mobileSidebarOpen: true })

    const stored = JSON.parse(localStorage.getItem('ui') ?? '{}') as {
      state?: Record<string, unknown>
    }

    expect(stored.state).toEqual({ sidebarCollapsed: true })
  })

  it('ignores mobile overlay state written by an older version', async () => {
    localStorage.setItem(
      'ui',
      JSON.stringify({
        state: { sidebarCollapsed: true, mobileSidebarOpen: true },
        version: 0,
      }),
    )

    await useUIStore.persist.rehydrate()

    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
    expect(useUIStore.getState().mobileSidebarOpen).toBe(false)
  })
})
