import { create } from 'zustand'
import {
  type Notification,
  apiGetNotifications,
  apiGetUnreadCount,
  apiMarkAllRead,
  apiMarkRead,
} from '../api/notifications'

let unreadCountPromise: Promise<void> | null = null

interface NotificationsState {
  notifications: Notification[]
  unreadCount: number
  panelOpen: boolean
  load: () => Promise<void>
  loadUnreadCount: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  setPanelOpen: (open: boolean) => void
  addFromSse: (notif: Notification) => void
}

export const useNotificationsStore = create<NotificationsState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,

  async load() {
    try {
      const notifications = await apiGetNotifications()
      const unreadCount = notifications.filter((n) => n.read_at === null).length
      set({ notifications, unreadCount })
    } catch {
      // ignore — stale state is acceptable
    }
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
    // Load fresh notifications when panel opens
    if (open) void get().load()
  },

  addFromSse(notif) {
    set((s) => ({
      notifications: [notif, ...s.notifications],
      unreadCount: s.unreadCount + 1,
    }))
  },
}))
