import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { type ActivityEvent, type Notification, apiGetActivity } from '../api/notifications'
import { useNotificationsStore } from '../stores/notifications'
import { cn } from '../utils/cn'

type Tab = 'notifications' | 'activity'

export function NotificationsPage() {
  const [tab, setTab] = useState<Tab>('notifications')
  const { notifications, unreadCount, load, markRead, markAllRead } = useNotificationsStore()

  const [activity, setActivity] = useState<ActivityEvent[]>([])
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
    return () => {
      cancelled = true
    }
  }, [tab])

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
          <NotificationsList notifications={notifications} onMarkRead={(id) => void markRead(id)} />
        ) : (
          <ActivityList activity={activity} loading={activityLoading} />
        )}
      </div>
    </div>
  )
}

function NotificationsList({
  notifications,
  onMarkRead,
}: {
  notifications: Notification[]
  onMarkRead: (id: string) => void
}) {
  if (notifications.length === 0) {
    return <p className="text-sm text-zinc-600 py-6 text-center">No notifications yet.</p>
  }

  return (
    <div className="space-y-1">
      {notifications.map((n) => (
        <div
          key={n.id}
          onClick={() => {
            if (n.read_at === null) onMarkRead(n.id)
          }}
          className={cn(
            'flex items-start gap-3 px-4 py-3 rounded-lg border transition-colors',
            n.read_at === null
              ? 'bg-blue-500/5 border-blue-500/20 cursor-pointer hover:bg-blue-500/10'
              : 'bg-zinc-900 border-zinc-800',
          )}
        >
          {n.read_at === null && (
            <span className="mt-2 shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500" />
          )}
          <div className={cn('flex-1 min-w-0', n.read_at !== null && 'pl-4')}>
            <p className="text-sm font-medium text-zinc-200">{n.title}</p>
            <p className="text-sm text-zinc-400 mt-0.5">{n.body}</p>
            <p className="text-xs text-zinc-600 mt-1">{new Date(n.created_at).toLocaleString()}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ActivityList({ activity, loading }: { activity: ActivityEvent[]; loading: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
        <p className="text-xs text-zinc-500">
          Activity now shows your own timeline. Group activity feeds have been removed from the app.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
        </div>
      ) : activity.length === 0 ? (
        <p className="text-sm text-zinc-600 py-6 text-center">No activity yet.</p>
      ) : (
        <div className="space-y-1">
          {activity.map((e) => (
            <div
              key={e.event_id}
              className="flex items-start gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                    {e.event_type}
                  </span>
                  <span className="text-xs text-zinc-500 truncate">by {e.actor_display_name}</span>
                </div>
                <p className="text-xs text-zinc-600 mt-1">
                  {new Date(e.created_at).toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
