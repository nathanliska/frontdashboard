import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Notification } from '../api/notifications'

const { apiGetNotifications, apiGetUnreadCount, apiMarkAllRead, apiMarkRead } = vi.hoisted(() => ({
  apiGetNotifications: vi.fn(),
  apiGetUnreadCount: vi.fn(),
  apiMarkAllRead: vi.fn(),
  apiMarkRead: vi.fn(),
}))
vi.mock('../api/notifications', () => ({
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
}))

import { useNotificationsStore } from './notifications'
import { bumpSessionGeneration } from './sessionGeneration'

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
    let resolveLoad!: (n: Notification[]) => void
    apiGetNotifications.mockReturnValue(
      new Promise<Notification[]>((r) => {
        resolveLoad = r
      }),
    )

    const pending = useNotificationsStore.getState().load()
    bumpSessionGeneration() // account boundary while the fetch is in flight
    resolveLoad([NOTIF_A])
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
    apiGetNotifications.mockResolvedValue([NOTIF_A])
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

describe('notification load failures (#26)', () => {
  it('records a failure when nothing is cached, and a retry clears it', async () => {
    apiGetNotifications.mockRejectedValueOnce(new Error('offline'))
    await useNotificationsStore.getState().load()

    expect(useNotificationsStore.getState().loadFailed).toBe(true)
    expect(useNotificationsStore.getState().loaded).toBe(false)

    apiGetNotifications.mockResolvedValueOnce([NOTIF_A])
    await useNotificationsStore.getState().load()

    expect(useNotificationsStore.getState().loadFailed).toBe(false)
    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
  })

  it('keeps serving a cached list when a background refresh fails', async () => {
    apiGetNotifications.mockResolvedValueOnce([NOTIF_A])
    await useNotificationsStore.getState().load()

    apiGetNotifications.mockRejectedValueOnce(new Error('offline'))
    await useNotificationsStore.getState().load()

    // The stale list stays visible and no error state kicks it out.
    expect(useNotificationsStore.getState().notifications).toEqual([NOTIF_A])
    expect(useNotificationsStore.getState().loadFailed).toBe(false)
  })
})
