import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { type Notification, apiGetActivity } from '../api/notifications'
import { ActivityFeed } from '../components/notifications/ActivityFeed'
import { NotificationFeed } from '../components/notifications/NotificationFeed'
import { APP_RESYNC_EVENT } from '../hooks/useSSE'
import { useNotificationsStore } from '../stores/notifications'
import { cn } from '../utils/shared/cn'
import { getNotificationDestination } from '../utils/notifications/notificationFeedUtils'

type Tab = 'notifications' | 'activity'

export function NotificationsPage() {
  const [tab, setTab] = useState<Tab>('notifications')
  const navigate = useNavigate()
  const notifications = useNotificationsStore((s) => s.notifications)
  const unreadCount = useNotificationsStore((s) => s.unreadCount)
  const load = useNotificationsStore((s) => s.load)
  const markRead = useNotificationsStore((s) => s.markRead)
  const markAllRead = useNotificationsStore((s) => s.markAllRead)

  const [activity, setActivity] = useState<Awaited<ReturnType<typeof apiGetActivity>>>([])
  const [activityLoading, setActivityLoading] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== 'activity') return
    let cancelled = false

    async function loadActivity() {
      setActivityLoading(true)
      try {
        const nextActivity = await apiGetActivity()
        if (!cancelled) {
          setActivity(nextActivity)
        }
      } finally {
        if (!cancelled) {
          setActivityLoading(false)
        }
      }
    }

    void loadActivity()
    function onResync() {
      void loadActivity()
    }
    window.addEventListener(APP_RESYNC_EVENT, onResync)
    return () => {
      cancelled = true
      window.removeEventListener(APP_RESYNC_EVENT, onResync)
    }
  }, [tab])

  function handleNotificationClick(notification: Notification) {
    if (notification.read_at === null) {
      void markRead(notification.id)
    }

    const destination = getNotificationDestination(notification)
    if (destination) {
      navigate(destination)
    }
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 shrink-0 pl-12 sm:pl-0 min-h-10">
        <h1 className="min-w-0 text-xl font-semibold text-zinc-100 truncate">Notifications</h1>
        {tab === 'notifications' && unreadCount > 0 && (
          <button
            onClick={() => void markAllRead()}
            className="shrink-0 flex items-center gap-1.5 text-xs sm:text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <Check size={14} />
            Mark all read
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-800 shrink-0">
        {(['notifications', 'activity'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-zinc-100 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300',
            )}
          >
            {t}
            {t === 'notifications' && unreadCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-500 text-white text-[9px] font-bold">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'notifications' ? (
          <NotificationFeed
            notifications={notifications}
            emptyMessage="No notifications yet."
            onOpen={handleNotificationClick}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
              <p className="text-xs text-zinc-500">Activity now shows your own timeline.</p>
            </div>
            <ActivityFeed activity={activity} loading={activityLoading} />
          </div>
        )}
      </div>
    </div>
  )
}
