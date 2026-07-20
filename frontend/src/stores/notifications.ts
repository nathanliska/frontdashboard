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

interface NotificationsState {
  notifications: Notification[]
  unreadCount: number
  panelOpen: boolean
  loaded: boolean
  load: () => Promise<void>
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

    async load() {
      if (notificationsPromise) return notificationsPromise

      notificationsPromise = (async () => {
        const guard = sessionGuard()
        try {
          const notifications = await apiGetNotifications()
          // The list endpoint is capped, so it cannot authoritatively replace the
          // separately loaded unread total.
          guard.set({ notifications, loaded: true })
        } catch {
          // ignore — stale state is acceptable
        }
      })().finally(() => {
        notificationsPromise = null
      })

      return notificationsPromise
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
      set({
        notifications: [],
        unreadCount: 0,
        panelOpen: false,
        loaded: false,
      })
    },
  }
})
