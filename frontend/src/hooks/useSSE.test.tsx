// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefreshOutcome } from '../api/client'
import { handleCalendarResourceEvent } from '../resources/calendarData'
import { handleListResourceEvent } from '../resources/listData'
import { useAuthStore } from '../stores/auth'
import { resetDashboardData, useDashboardStore } from '../stores/dashboard'
import { useNotificationsStore } from '../stores/notifications'
import { APP_RESYNC_EVENT, SSE_RECONNECT_MAX_MS, useSSE } from './useSSE'

const { handlerCallOrder } = vi.hoisted(() => ({
  handlerCallOrder: [] as string[],
}))

vi.mock('../resources/listData', () => ({
  handleListResourceEvent: vi.fn(() => {
    handlerCallOrder.push('list')
  }),
}))

vi.mock('../resources/calendarData', () => ({
  handleCalendarResourceEvent: vi.fn(),
}))

vi.mock('../resources/agendaData', () => ({
  handleAgendaResourceEvent: vi.fn(() => {
    handlerCallOrder.push('agenda')
  }),
}))

const { tryRefreshMock } = vi.hoisted(() => ({
  tryRefreshMock: vi.fn<() => Promise<RefreshOutcome>>(),
}))

vi.mock('../api/client', () => ({
  tryRefresh: tryRefreshMock,
}))

type Listener = (event: MessageEvent<string>) => void

class MockEventSource {
  static instances: MockEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2

  close = vi.fn()
  listeners = new Map<string, Listener[]>()
  url: string
  options?: EventSourceInit
  readyState: number = MockEventSource.CONNECTING
  onerror: (() => void) | null = null

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

  triggerError() {
    this.onerror?.()
  }
}

function TestHarness() {
  useSSE()
  return null
}

/**
 * A complete, contract-valid activity frame. Frames are validated against the generated
 * ActivitySseEvent schema now, so a partial fixture would be dropped rather than routed.
 */
function frame(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: 1,
    entity_version: 1,
    actor_id: 'user-2',
    actor_display_name: 'Other User',
    created_at: '2026-04-05T00:00:00Z',
    ...overrides,
  })
}

describe('useSSE', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Module-level load/debounce state lives outside the store, so setState alone won't clear it.
    resetDashboardData()
    handlerCallOrder.length = 0
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
        frame({
          event_type: 'calendar.event.updated',
          entity_id: 'event-1',
          entity_type: 'calendar_event',
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

  it('drops a well-formed frame that is off-contract instead of routing a wrong shape', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      // Valid JSON, but `entity_id` is missing and `event_id` has the wrong type.
      es.dispatch(
        'calendar.event.updated',
        JSON.stringify({ event_type: 'calendar.event.updated', event_id: 'not-a-number' }),
      )
    })

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled()
    })
    expect(handleCalendarResourceEvent).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('keeps payload keys the generated contract does not model', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch(
        'list.item.updated',
        frame({
          event_type: 'list.item.updated',
          entity_id: 'item-1',
          entity_type: 'list_item',
          // `title` is not in ActivitySsePayload — backend payloads are extra="allow", so
          // validation must not strip it on the way through.
          payload: { dashboard_id: 'dash-1', list_id: 'list-1', title: 'Milk' },
        }),
      )
    })

    await waitFor(() => {
      expect(handleListResourceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ title: 'Milk' }),
        }),
      )
    })
  })

  it('routes list SSE events to both the list resource layer and dashboard content handler', async () => {
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    act(() => {
      es.dispatch(
        'list.item.updated',
        frame({
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
        frame({
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

describe('useSSE reconnect backoff', () => {
  let replaceSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
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

    replaceSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...window.location, replace: replaceSpy },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    window.history.pushState({}, '', '/')
  })

  function latestStream() {
    return MockEventSource.instances[MockEventSource.instances.length - 1]
  }

  /** Fail the newest stream with an HTTP-level error, then let `ms` of backoff elapse. */
  async function failLatest(ms: number) {
    const es = latestStream()
    es.readyState = MockEventSource.CLOSED
    act(() => {
      es.triggerError()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('does not call tryRefresh or reconnect when readyState is CONNECTING (browser is already retrying)', async () => {
    render(<TestHarness />)
    const es = MockEventSource.instances[0]
    es.readyState = MockEventSource.CONNECTING

    act(() => {
      es.triggerError()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(tryRefreshMock).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('waits out the backoff before reconnecting rather than retrying immediately', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    render(<TestHarness />)

    const es = MockEventSource.instances[0]
    es.readyState = MockEventSource.CLOSED
    act(() => {
      es.triggerError()
    })

    // Nothing may happen before the first delay elapses — not even the refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(tryRefreshMock).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(tryRefreshMock).toHaveBeenCalledTimes(1)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1]).not.toBe(es)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('doubles the delay on each successive failure', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    render(<TestHarness />)

    await failLatest(1000)
    expect(MockEventSource.instances).toHaveLength(2)

    // Second failure needs 2s: 1s must not be enough.
    const second = latestStream()
    second.readyState = MockEventSource.CLOSED
    act(() => {
      second.triggerError()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(MockEventSource.instances).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(MockEventSource.instances).toHaveLength(3)
  })

  it('caps the delay and keeps retrying indefinitely instead of going permanently dead', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    render(<TestHarness />)

    // Ten consecutive failures: a capped backoff must still be reconnecting at the end. The
    // old hard cap of 3 would have stopped here forever, leaving a live-looking, dead app.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await failLatest(SSE_RECONNECT_MAX_MS)
      expect(MockEventSource.instances).toHaveLength(attempt + 2)
    }

    // Still capped at 30s, not grown to 2^10 seconds.
    await failLatest(SSE_RECONNECT_MAX_MS)
    expect(MockEventSource.instances).toHaveLength(12)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('resets the backoff once a stream connects successfully', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    render(<TestHarness />)

    await failLatest(1000)
    await failLatest(2000)
    expect(MockEventSource.instances).toHaveLength(3)

    act(() => {
      latestStream().dispatch('connected')
    })

    // Back to the 1s base delay — without the reset this would still be waiting on 4s.
    await failLatest(1000)
    expect(MockEventSource.instances).toHaveLength(4)
  })

  it('cancels a pending reconnect when the hook unmounts', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    const view = render(<TestHarness />)

    const es = MockEventSource.instances[0]
    es.readyState = MockEventSource.CLOSED
    act(() => {
      es.triggerError()
    })

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    // A reconnect firing after logout would re-open a stream for a signed-out user.
    expect(tryRefreshMock).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('does not redirect to /login when the hook unmounts while the refresh is in flight', async () => {
    // Distinct from the timer-cancel case above: here the timer has already fired and the
    // refresh is pending, so clearTimeout cannot help. Without the `cancelled` guard, logging
    // out during that window would bounce the user to /login on a failed refresh they no
    // longer care about.
    let resolveRefresh!: (outcome: RefreshOutcome) => void
    tryRefreshMock.mockReturnValue(
      new Promise<RefreshOutcome>((resolve) => {
        resolveRefresh = resolve
      }),
    )
    const view = render(<TestHarness />)

    const es = MockEventSource.instances[0]
    es.readyState = MockEventSource.CLOSED
    act(() => {
      es.triggerError()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(tryRefreshMock).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      resolveRefresh('unauthorized')
      await Promise.resolve()
    })

    expect(replaceSpy).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('navigates to /login when the refresh fails, without reconnecting', async () => {
    tryRefreshMock.mockResolvedValue('unauthorized')
    render(<TestHarness />)

    await failLatest(1000)

    expect(replaceSpy).toHaveBeenCalledWith('/login')
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('reconnects instead of logging out when refresh is rate-limited (429)', async () => {
    // A transient 429 on /refresh must not bounce the user to /login. The stream
    // reconnects and re-enters the widening backoff, which self-throttles refreshes.
    tryRefreshMock.mockResolvedValue('rate-limited')
    render(<TestHarness />)

    await failLatest(1000)

    expect(replaceSpy).not.toHaveBeenCalled()
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('resyncs after a reconnect, because the fresh EventSource sends no Last-Event-ID', async () => {
    tryRefreshMock.mockResolvedValue('refreshed')
    render(<TestHarness />)

    await failLatest(1000)
    expect(MockEventSource.instances).toHaveLength(2)

    // The server only sends a `resync` frame when it sees a Last-Event-ID header, and a fresh
    // EventSource never sends one. Events broadcast during the outage are already lost, so the
    // client must drive the resync itself off `connected` or the caches stay silently wrong.
    act(() => {
      MockEventSource.instances[1].dispatch('connected')
    })

    expect(handleListResourceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'resync' }),
    )
  })

  it('does not resync on the first connect of a stream that never errored', async () => {
    render(<TestHarness />)

    act(() => {
      MockEventSource.instances[0].dispatch('connected')
    })

    // An initial connect follows the components' own REST fetches — resyncing here would be the
    // GET storm this whole design exists to avoid.
    expect(handleListResourceEvent).not.toHaveBeenCalled()
  })
})
