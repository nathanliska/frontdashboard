import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notification } from '../api/notifications'

const { apiGetActivity, apiGetNotifications, apiGetUnreadCount, apiMarkAllRead, apiMarkRead } =
  vi.hoisted(() => ({
    apiGetActivity: vi.fn(),
    apiGetNotifications: vi.fn(),
    apiGetUnreadCount: vi.fn(),
    apiMarkAllRead: vi.fn(),
    apiMarkRead: vi.fn(),
  }))
vi.mock('../api/notifications', () => ({
  apiGetActivity,
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
}))

import type { ActivityEvent } from '../api/notifications'
import { useNotificationsStore } from './notifications'
import { bumpSessionGeneration } from './sessionGeneration'

const VIEWER_ID = 'user-1'

function activityEvent(eventId: number, eventType: string): ActivityEvent {
  return {
    event_id: eventId,
    event_type: eventType,
    entity_type: 'list',
    entity_id: 'entity-1',
    actor_id: VIEWER_ID,
    actor_display_name: 'Example User',
    payload: {},
    created_at: '2026-08-02T00:00:00Z',
  }
}

const NOTIF_A: Notification = { id: 'a', read_at: null } as Notification
const READ_NOTIF_A: Notification = {
  id: 'a',
  read_at: '2026-07-17T00:00:00Z',
} as Notification

beforeEach(() => {
  vi.clearAllMocks()
  useNotificationsStore.getState().reset()
})

describe('notifications store session-boundary guard', () => {
  it('drops a load whose response lands after a session boundary', async () => {
    let resolveLoad!: (page: { items: Notification[]; next_cursor: string | null }) => void
    apiGetNotifications.mockReturnValue(
      new Promise<{ items: Notification[]; next_cursor: string | null }>((r) => {
        resolveLoad = r
      }),
    )

    const pending = useNotificationsStore.getState().load()
    bumpSessionGeneration() // account boundary while the fetch is in flight
    resolveLoad({ items: [NOTIF_A], next_cursor: null })
    await pending

    expect(useNotificationsStore.getState().notifications).toEqual([]) // A's list was dropped
    expect(useNotificationsStore.getState().loaded).toBe(false)
  })

  it('drops a markRead whose response lands after a session boundary', async () => {
    useNotificationsStore.setState({ notifications: [NOTIF_A], unreadCount: 1 })
    let resolveMark!: (n: Notification) => void
    apiMarkRead.mockReturnValue(
      new Promise<Notification>((r) => {
        resolveMark = r
      }),
    )

    const pending = useNotificationsStore.getState().markRead('a')
    bumpSessionGeneration()
    resolveMark({ id: 'a', read_at: '2026-07-17T00:00:00Z' } as Notification)
    await pending

    expect(useNotificationsStore.getState().unreadCount).toBe(1) // markRead write dropped
  })

  it('drops a loadUnreadCount whose response lands after a session boundary', async () => {
    useNotificationsStore.setState({ unreadCount: 3 })
    let resolveCount!: (n: number) => void
    apiGetUnreadCount.mockReturnValue(
      new Promise<number>((r) => {
        resolveCount = r
      }),
    )

    const pending = useNotificationsStore.getState().loadUnreadCount()
    bumpSessionGeneration()
    resolveCount(99)
    await pending

    expect(useNotificationsStore.getState().unreadCount).toBe(3) // loadUnreadCount write dropped
  })

  it('drops a markAllRead whose response lands after a session boundary', async () => {
    useNotificationsStore.setState({ notifications: [NOTIF_A], unreadCount: 1 })
    let resolveMarkAll!: () => void
    apiMarkAllRead.mockReturnValue(
      new Promise<void>((r) => {
        resolveMarkAll = r
      }),
    )

    const pending = useNotificationsStore.getState().markAllRead()
    bumpSessionGeneration()
    resolveMarkAll()
    await pending

    expect(useNotificationsStore.getState().unreadCount).toBe(1) // markAllRead write dropped
  })
})

describe('notifications store unread accounting', () => {
  it('does not replace the authoritative unread total with the capped notification page', async () => {
    apiGetNotifications.mockResolvedValue({ items: [NOTIF_A], next_cursor: null })
    useNotificationsStore.setState({ unreadCount: 75 })

    await useNotificationsStore.getState().load()

    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
    expect(useNotificationsStore.getState().unreadCount).toBe(75)
  })

  it('ignores duplicate notification SSE delivery', () => {
    useNotificationsStore.setState({ notifications: [NOTIF_A], unreadCount: 1 })

    useNotificationsStore.getState().addFromSse(NOTIF_A)

    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
    expect(useNotificationsStore.getState().unreadCount).toBe(1)
  })

  it('only decrements unread count when an unread notification becomes read', async () => {
    apiMarkRead.mockResolvedValue(READ_NOTIF_A)
    useNotificationsStore.setState({ notifications: [READ_NOTIF_A], unreadCount: 4 })

    await useNotificationsStore.getState().markRead('a')

    expect(useNotificationsStore.getState().unreadCount).toBe(4)

    useNotificationsStore.setState({ notifications: [NOTIF_A], unreadCount: 4 })
    await useNotificationsStore.getState().markRead('a')

    expect(useNotificationsStore.getState().unreadCount).toBe(3)
  })
})

describe('notification load failures', () => {
  it('records a failure when nothing is cached, and a retry clears it', async () => {
    apiGetNotifications.mockRejectedValueOnce(new Error('offline'))
    await useNotificationsStore.getState().load()

    expect(useNotificationsStore.getState().loadFailed).toBe(true)
    expect(useNotificationsStore.getState().loaded).toBe(false)

    apiGetNotifications.mockResolvedValueOnce({ items: [NOTIF_A], next_cursor: null })
    await useNotificationsStore.getState().load()

    expect(useNotificationsStore.getState().loadFailed).toBe(false)
    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
  })

  it('keeps serving a cached list when a background refresh fails', async () => {
    apiGetNotifications.mockResolvedValueOnce({ items: [NOTIF_A], next_cursor: null })
    await useNotificationsStore.getState().load()

    apiGetNotifications.mockRejectedValueOnce(new Error('offline'))
    await useNotificationsStore.getState().load()

    // The stale list stays visible and no error state kicks it out.
    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
    expect(useNotificationsStore.getState().loadFailed).toBe(false)
  })
})

describe('notification pagination', () => {
  it('appends older pages with id-dedupe and stops when the cursor runs out', async () => {
    const NOTIF_B = { id: 'b', read_at: null } as Notification
    apiGetNotifications.mockResolvedValueOnce({ items: [NOTIF_A], next_cursor: 'cursor-1' })
    await useNotificationsStore.getState().load()
    expect(useNotificationsStore.getState().hasMore).toBe(true)

    // The next page repeats A (a row that moved sections mid-scroll) — dedupe absorbs it.
    apiGetNotifications.mockResolvedValueOnce({ items: [NOTIF_A, NOTIF_B], next_cursor: null })
    await useNotificationsStore.getState().loadMore()

    const state = useNotificationsStore.getState()
    expect(apiGetNotifications).toHaveBeenLastCalledWith('cursor-1')
    expect(state.notifications.map((n) => n.id)).toEqual(['a', 'b'])
    expect(state.hasMore).toBe(false)

    // Cursor exhausted: another loadMore is a no-op, not a request.
    await useNotificationsStore.getState().loadMore()
    expect(apiGetNotifications).toHaveBeenCalledTimes(2)
  })

  it('keeps the load-more affordance when the page fetch fails', async () => {
    apiGetNotifications.mockResolvedValueOnce({ items: [NOTIF_A], next_cursor: 'cursor-1' })
    await useNotificationsStore.getState().load()

    apiGetNotifications.mockRejectedValueOnce(new Error('offline'))
    await useNotificationsStore.getState().loadMore()

    const state = useNotificationsStore.getState()
    expect(state.hasMore).toBe(true) // retryable, not a dead end
    expect(state.loadingMore).toBe(false)
    expect(state.notifications).toEqual([NOTIF_A])
  })
})

describe('activity feed filtering', () => {
  it('asks the endpoint for every type in the chosen category', async () => {
    apiGetActivity.mockResolvedValue([])
    useNotificationsStore.getState().setActivityFilter('lists')
    await vi.waitFor(() => expect(apiGetActivity).toHaveBeenCalled())

    expect(apiGetActivity).toHaveBeenCalledWith({
      eventTypes: ['list.created', 'list.updated', 'list.deleted', 'list.reordered'],
    })
  })

  it('keeps the filter when paging older history', async () => {
    apiGetActivity.mockResolvedValue([activityEvent(9, 'list.created')])
    useNotificationsStore.getState().setActivityFilter('lists')
    await vi.waitFor(() => expect(useNotificationsStore.getState().activityLoaded).toBe(true))

    await useNotificationsStore.getState().loadMoreActivity()

    expect(apiGetActivity).toHaveBeenLastCalledWith({
      eventTypes: ['list.created', 'list.updated', 'list.deleted', 'list.reordered'],
      before_event_id: 9,
    })
  })

  it('discards a page that answers a filter the user has already moved off', async () => {
    let resolveLists!: (events: ActivityEvent[]) => void
    apiGetActivity.mockReturnValueOnce(
      new Promise<ActivityEvent[]>((r) => {
        resolveLists = r
      }),
    )
    useNotificationsStore.getState().setActivityFilter('lists')

    apiGetActivity.mockResolvedValueOnce([activityEvent(2, 'calendar.event.created')])
    useNotificationsStore.getState().setActivityFilter('calendar')
    await vi.waitFor(() => expect(useNotificationsStore.getState().activityLoaded).toBe(true))

    resolveLists([activityEvent(1, 'list.created')])
    await vi.waitFor(() => expect(apiGetActivity).toHaveBeenCalledTimes(2))

    expect(useNotificationsStore.getState().activity.map((e) => e.event_id)).toEqual([2])
  })

  it('keeps the spinner up when a superseded request lands first', async () => {
    let resolveLists!: (events: ActivityEvent[]) => void
    apiGetActivity.mockReturnValueOnce(
      new Promise<ActivityEvent[]>((r) => {
        resolveLists = r
      }),
    )
    useNotificationsStore.getState().setActivityFilter('lists')

    apiGetActivity.mockReturnValueOnce(new Promise<ActivityEvent[]>(() => {}))
    useNotificationsStore.getState().setActivityFilter('calendar')

    resolveLists([])
    await vi.waitFor(() => expect(apiGetActivity).toHaveBeenCalledTimes(2))

    // The abandoned request must not clear flags the live one owns, or the feed renders its
    // empty state over a fetch that hasn't landed.
    expect(useNotificationsStore.getState().activityLoading).toBe(true)
    expect(useNotificationsStore.getState().activityLoaded).toBe(false)
  })

  it('appends a live event the active filter asked for, hidden-by-default or not', async () => {
    apiGetActivity.mockResolvedValue([])
    useNotificationsStore.getState().setActivityFilter('list-items')
    await vi.waitFor(() => expect(useNotificationsStore.getState().activityLoaded).toBe(true))

    // Hidden from the default view, but naming its category is asking to see it — as the
    // endpoint would, so the row has to survive a reload.
    useNotificationsStore
      .getState()
      .addActivityFromSse(activityEvent(3, 'list.item.checked'), VIEWER_ID)

    expect(useNotificationsStore.getState().activity.map((e) => e.event_id)).toEqual([3])
  })

  it('drops a live event outside the active filter rather than showing it until reload', async () => {
    apiGetActivity.mockResolvedValue([])
    useNotificationsStore.getState().setActivityFilter('calendar')
    await vi.waitFor(() => expect(useNotificationsStore.getState().activityLoaded).toBe(true))

    useNotificationsStore.getState().addActivityFromSse(activityEvent(4, 'list.created'), VIEWER_ID)

    expect(useNotificationsStore.getState().activity).toEqual([])
  })
})
