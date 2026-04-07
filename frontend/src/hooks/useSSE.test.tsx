import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { useCalendarStore } from '../stores/calendar'
import { useDashboardStore } from '../stores/dashboard'
import { useListsStore } from '../stores/lists'
import { useNotificationsStore } from '../stores/notifications'
import { APP_RESYNC_EVENT, useSSE } from './useSSE'

type Listener = (event: MessageEvent<string>) => void

class MockEventSource {
  static instances: MockEventSource[] = []

  close = vi.fn()
  listeners = new Map<string, Listener[]>()
  url: string
  options?: EventSourceInit

  constructor(url: string, options?: EventSourceInit) {
    this.url = url
    this.options = options
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  dispatch(type: string, data = '') {
    const event = new MessageEvent<string>(type, { data })
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function TestHarness() {
  useSSE()
  return null
}

describe('useSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.instances = []
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource
    window.history.pushState({}, '', '/dashboards')

    useAuthStore.setState({
      status: 'authenticated',
      user: {
        id: 'user-1',
        email: 'user@example.com',
        display_name: 'Example User',
        preferences: {},
      },
    })

    useListsStore.setState({
      handleSseEvent: vi.fn().mockResolvedValue(undefined),
    })

    useDashboardStore.setState({
      handleDashboardEvent: vi.fn().mockResolvedValue(undefined),
      handleContentEvent: vi.fn(),
    })

    useNotificationsStore.setState({
      panelOpen: false,
      load: vi.fn().mockResolvedValue(undefined),
      loadUnreadCount: vi.fn().mockResolvedValue(undefined),
    })

    useCalendarStore.setState({
      windowStart: null,
      windowEnd: null,
      dashboardId: null,
      loadOccurrences: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    window.history.pushState({}, '', '/')
  })

  it('refreshes unread count on resync without fetching the full notification list by default', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    expect(es?.url).toBe('/api/sse')

    act(() => {
      es.dispatch('resync')
    })

    await waitFor(() => {
      expect(useListsStore.getState().handleSseEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'resync' }),
      )
    })
    expect(useDashboardStore.getState().handleDashboardEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'resync' }),
    )
    expect(useDashboardStore.getState().handleContentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'resync' }),
    )
    expect(useNotificationsStore.getState().loadUnreadCount).toHaveBeenCalledTimes(1)
    expect(useNotificationsStore.getState().load).not.toHaveBeenCalled()
  })

  it('reloads the notifications list on resync when the notifications page is open', async () => {
    window.history.pushState({}, '', '/notifications')

    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    expect(es?.url).toBe('/api/sse')

    act(() => {
      es.dispatch('resync')
    })

    await waitFor(() => {
      expect(useNotificationsStore.getState().loadUnreadCount).toHaveBeenCalledTimes(1)
    })
    expect(useNotificationsStore.getState().load).toHaveBeenCalledTimes(1)
  })

  it('dispatches an app-level resync event for page-local data refreshes', async () => {
    const onAppResync = vi.fn()
    window.addEventListener(APP_RESYNC_EVENT, onAppResync)

    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    expect(es?.url).toBe('/api/sse')

    act(() => {
      es.dispatch('resync')
    })

    await waitFor(() => {
      expect(onAppResync).toHaveBeenCalledTimes(1)
    })

    window.removeEventListener(APP_RESYNC_EVENT, onAppResync)
  })
})
