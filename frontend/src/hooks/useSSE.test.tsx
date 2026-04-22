// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { handleListResourceEvent } from '../resources/listData'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { useNotificationsStore } from '../stores/notifications'
import { APP_RESYNC_EVENT, useSSE } from './useSSE'

vi.mock('../resources/listData', () => ({
  handleListResourceEvent: vi.fn(),
}))

vi.mock('../resources/calendarData', () => ({
  handleCalendarResourceEvent: vi.fn(),
}))

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

    useDashboardStore.setState({
      handleDashboardEvent: vi.fn().mockResolvedValue(undefined),
      handleContentEvent: vi.fn(),
    })

    useNotificationsStore.setState({
      panelOpen: false,
      load: vi.fn().mockResolvedValue(undefined),
      loadUnreadCount: vi.fn().mockResolvedValue(undefined),
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
      expect(handleListResourceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'resync' }),
      )
    })
    expect(handleCalendarResourceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'resync' }),
    )
    expect(useDashboardStore.getState().handleDashboardEvent).toHaveBeenCalledWith(
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

  it('routes valid calendar SSE events to the shared calendar resource layer', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch(
        'calendar.event.updated',
        JSON.stringify({
          event_type: 'calendar.event.updated',
          entity_id: 'event-1',
          payload: { dashboard_id: 'dash-1' },
        }),
      )
    })

    await waitFor(() => {
      expect(handleCalendarResourceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'calendar.event.updated' }),
      )
    })
  })

  it('does not route malformed calendar SSE events to the resource layer', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch('calendar.event.updated', '{not-json')
    })

    await waitFor(() => {
      expect(handleCalendarResourceEvent).not.toHaveBeenCalled()
    })
  })

  it('routes list SSE events to both the list resource layer and dashboard content handler', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch(
        'list.item.updated',
        JSON.stringify({
          event_type: 'list.item.updated',
          entity_id: 'item-1',
          entity_type: 'list_item',
          payload: { dashboard_id: 'dash-1', list_id: 'list-1' },
        }),
      )
    })

    await waitFor(() => {
      expect(handleListResourceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'list.item.updated' }),
      )
      expect(useDashboardStore.getState().handleContentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'list.item.updated' }),
      )
    })
  })

  it('routes dashboard share SSE events to the dashboard store handler', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch(
        'dashboard.share_added',
        JSON.stringify({
          event_type: 'dashboard.share_added',
          entity_id: 'dash-1',
          entity_type: 'dashboard',
          payload: { dashboard_id: 'dash-1', changed_fields: ['shares'], share_action: 'added' },
        }),
      )
    })

    await waitFor(() => {
      expect(useDashboardStore.getState().handleDashboardEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'dashboard.share_added' }),
      )
    })
  })
})
