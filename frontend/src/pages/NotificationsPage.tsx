import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Notification } from '../api/notifications'
import { ActivityFeed } from '../components/notifications/ActivityFeed'
import { ActivityFilter } from '../components/notifications/ActivityFilter'
import { NotificationFeed } from '../components/notifications/NotificationFeed'
import { useNotificationsStore } from '../stores/notifications'
import {
  ACTIVITY_FILTER_ALL,
  getNotificationDestination,
} from '../utils/notifications/notificationFeedUtils'
import { cn } from '../utils/shared/cn'

type Tab = 'notifications' | 'activity'

export function NotificationsPage() {
  const [tab, setTab] = useState<Tab>('notifications')
  const navigate = useNavigate()
  const notifications = useNotificationsStore((s) => s.notifications)
  const unreadCount = useNotificationsStore((s) => s.unreadCount)
  const load = useNotificationsStore((s) => s.load)
  const loadFailed = useNotificationsStore((s) => s.loadFailed)
  const hasMore = useNotificationsStore((s) => s.hasMore)
  const loadingMore = useNotificationsStore((s) => s.loadingMore)
  const loadMore = useNotificationsStore((s) => s.loadMore)
  const markRead = useNotificationsStore((s) => s.markRead)
  const markAllRead = useNotificationsStore((s) => s.markAllRead)

  const activity = useNotificationsStore((s) => s.activity)
  const activityLoading = useNotificationsStore((s) => s.activityLoading)
  const activityFailed = useNotificationsStore((s) => s.activityFailed)
  const activityHasMore = useNotificationsStore((s) => s.activityHasMore)
  const activityLoadingMore = useNotificationsStore((s) => s.activityLoadingMore)
  const loadActivity = useNotificationsStore((s) => s.loadActivity)
  const loadMoreActivity = useNotificationsStore((s) => s.loadMoreActivity)
  const activityFilter = useNotificationsStore((s) => s.activityFilter)
  const setActivityFilter = useNotificationsStore((s) => s.setActivityFilter)

  // Guarded as the sidebar panel guards it: SSE keeps the store current, and skipping the fetch
  // preserves any extra pages "Load more" appended.
  const loaded = useNotificationsStore((s) => s.loaded)
  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  // Same for activity: `loadActivity` returns immediately once loaded. Staleness is the stream's
  // call, so the resync refetch lives in `useSSE`.
  useEffect(() => {
    if (tab !== 'activity') return
    void loadActivity()
  }, [tab, loadActivity])

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
            type="button"
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
            type="button"
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
          loadFailed && notifications.length === 0 ? (
            <RetryState message="Couldn't load notifications." onRetry={() => void load()} />
          ) : (
            <>
              <NotificationFeed
                notifications={notifications}
                emptyMessage="No notifications yet."
                onOpen={handleNotificationClick}
              />
              {hasMore && <LoadMoreButton loading={loadingMore} onClick={() => void loadMore()} />}
            </>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
              <p className="min-w-0 text-xs text-zinc-500 truncate">
                Activity now shows your own timeline.
              </p>
              <ActivityFilter value={activityFilter} onChange={setActivityFilter} />
            </div>
            {activityFailed && !activityLoading ? (
              <RetryState message="Couldn't load activity." onRetry={() => void loadActivity()} />
            ) : (
              <>
                <ActivityFeed
                  activity={activity}
                  loading={activityLoading}
                  emptyMessage={
                    activityFilter === ACTIVITY_FILTER_ALL
                      ? 'No activity yet.'
                      : 'No activity of this kind yet.'
                  }
                />
                {activityHasMore && !activityLoading && (
                  <LoadMoreButton
                    loading={activityLoadingMore}
                    onClick={() => void loadMoreActivity()}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function RetryState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8">
      <p className="text-sm text-zinc-500">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
      >
        Try again
      </button>
    </div>
  )
}

function LoadMoreButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center py-3">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="rounded border border-zinc-800 px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  )
}
