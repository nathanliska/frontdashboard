import { create } from 'zustand'
import {
  type Notification,
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
} from '../api/notifications'

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

export const useNotificationsStore = create<NotificationsState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,
  loaded: false,

  async load() {
    if (notificationsPromise) return notificationsPromise

    notificationsPromise = (async () => {
      try {
        const notifications = await apiGetNotifications()
        const unreadCount = notifications.filter((n) => n.read_at === null).length
        set({ notifications, unreadCount, loaded: true })
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
      try {
        const count = await apiGetUnreadCount()
        set({ unreadCount: count })
      } catch {
        // ignore
      }
    })().finally(() => {
      unreadCountPromise = null
    })

    return unreadCountPromise
  },

  async markRead(id) {
    try {
      const updated = await apiMarkRead(id)
      set((s) => ({
        notifications: s.notifications.map((n) => (n.id === id ? updated : n)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }))
    } catch {
      // ignore
    }
  },

  async markAllRead() {
    try {
      await apiMarkAllRead()
      const now = new Date().toISOString()
      set((s) => ({
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
    set((s) => ({
      notifications: [notif, ...s.notifications],
      unreadCount: s.unreadCount + 1,
    }))
  },

  reset() {
    notificationsPromise = null
    unreadCountPromise = null
    set({
      notifications: [],
      unreadCount: 0,
      panelOpen: false,
      loaded: false,
    })
  },
}))
