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
