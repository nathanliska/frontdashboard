import { create } from 'zustand'
import {
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
  type Notification,
} from '../api/notifications'
import { bumpSessionGeneration, currentSessionGeneration } from './sessionGeneration'

let notificationsPromise: Promise<void> | null = null
let unreadCountPromise: Promise<void> | null = null
let loadMorePromise: Promise<void> | null = null
// Where the next older page starts. Module-level like the promises: it is request bookkeeping,
// not render state — hasMore below is the rendered fact.
let nextCursor: string | null = null

interface NotificationsState {
  notifications: Notification[]
  unreadCount: number
  panelOpen: boolean
  loaded: boolean
  /** Last load attempt failed and nothing is cached — render a retry state, not "no notifications" (#26). */
  loadFailed: boolean
  /** Older history exists past what is loaded — render a "Load more" affordance (#22). */
  hasMore: boolean
  loadingMore: boolean
  load: () => Promise<void>
  loadMore: () => Promise<void>
  loadUnreadCount: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  setPanelOpen: (open: boolean) => void
  addFromSse: (notif: Notification) => void
  reset: () => void
}

export const useNotificationsStore = create<NotificationsState>()((set, get) => {
  function sessionGuard() {
    const gen = currentSessionGeneration()
    return {
      set: ((...args: Parameters<typeof set>) => {
        if (gen === currentSessionGeneration()) set(...args)
      }) as typeof set,
    }
  }

  return {
    notifications: [],
    unreadCount: 0,
    panelOpen: false,
    loaded: false,
    loadFailed: false,
    hasMore: false,
    loadingMore: false,

    async load() {
      if (notificationsPromise) return notificationsPromise

      notificationsPromise = (async () => {
        const guard = sessionGuard()
        try {
          const page = await apiGetNotifications()
          // The list endpoint is capped, so it cannot authoritatively replace the
          // separately loaded unread total.
          nextCursor = page.next_cursor
          guard.set({
            notifications: page.items,
            loaded: true,
            loadFailed: false,
            hasMore: page.next_cursor !== null,
          })
        } catch {
          // Keep any stale list (better than blanking it), but record the failure: with nothing
          // cached, an outage otherwise renders as "No notifications" — indistinguishable from
          // an empty inbox and with no way to retry (#26).
          guard.set({ loadFailed: !get().loaded })
        }
      })().finally(() => {
        notificationsPromise = null
      })

      return notificationsPromise
    },

    async loadMore() {
      if (loadMorePromise) return loadMorePromise
      const cursor = nextCursor
      if (cursor === null) return

      loadMorePromise = (async () => {
        const guard = sessionGuard()
        set({ loadingMore: true })
        try {
          const page = await apiGetNotifications(cursor)
          nextCursor = page.next_cursor
          guard.set((s) => {
            // Dedupe by id: a row that moved sections between pages (read on another device
            // mid-scroll) can be emitted twice by keyset pagination — by design, see the route.
            const known = new Set(s.notifications.map((n) => n.id))
            return {
              notifications: [...s.notifications, ...page.items.filter((n) => !known.has(n.id))],
              hasMore: page.next_cursor !== null,
              loadingMore: false,
            }
          })
        } catch {
          // Keep hasMore so the button stays and the user can retry (#26).
          guard.set({ loadingMore: false })
        }
      })().finally(() => {
        loadMorePromise = null
      })

      return loadMorePromise
    },

    async loadUnreadCount() {
      if (unreadCountPromise) return unreadCountPromise

      unreadCountPromise = (async () => {
        const guard = sessionGuard()
        try {
          const count = await apiGetUnreadCount()
          guard.set({ unreadCount: count })
        } catch {
          // ignore
        }
      })().finally(() => {
        unreadCountPromise = null
      })

      return unreadCountPromise
    },

    async markRead(id) {
      const guard = sessionGuard()
      try {
        const updated = await apiMarkRead(id)
        guard.set((s) => {
          const current = s.notifications.find((notification) => notification.id === id)
          const becameRead = current?.read_at === null && updated.read_at !== null
          return {
            notifications: s.notifications.map((notification) =>
              notification.id === id ? updated : notification,
            ),
            unreadCount: becameRead ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
          }
        })
      } catch {
        // ignore
      }
    },

    async markAllRead() {
      const guard = sessionGuard()
      try {
        await apiMarkAllRead()
        const now = new Date().toISOString()
        guard.set((s) => ({
          notifications: s.notifications.map((n) =>
            n.read_at === null ? { ...n, read_at: now } : n,
          ),
          unreadCount: 0,
        }))
      } catch {
        // ignore
      }
    },

    setPanelOpen(open) {
      set({ panelOpen: open })
      if (open && !get().loaded) void get().load()
    },

    addFromSse(notif) {
      set((s) => {
        if (s.notifications.some((notification) => notification.id === notif.id)) return s
        return {
          notifications: [notif, ...s.notifications],
          unreadCount: notif.read_at === null ? s.unreadCount + 1 : s.unreadCount,
        }
      })
    },

    reset() {
      bumpSessionGeneration()
      notificationsPromise = null
      unreadCountPromise = null
      loadMorePromise = null
      nextCursor = null
      set({
        notifications: [],
        unreadCount: 0,
        panelOpen: false,
        loaded: false,
        loadFailed: false,
        hasMore: false,
        loadingMore: false,
      })
    },
  }
})
