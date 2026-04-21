import type { Notification } from '../../api/notifications'
import { getNotificationTypeLabel } from '../../utils/notifications/notificationFeedUtils'
import { cn } from '../../utils/shared/cn'

type NotificationFeedProps = {
  notifications: Notification[]
  emptyMessage: string
  onOpen: (notification: Notification) => void
  variant?: 'page' | 'panel'
}

type NotificationFeedItemProps = {
  notification: Notification
  onOpen: (notification: Notification) => void
  variant: 'page' | 'panel'
}

export function NotificationFeed({
  notifications,
  emptyMessage,
  onOpen,
  variant = 'page',
}: NotificationFeedProps) {
  if (notifications.length === 0) {
    return <p className="text-sm text-zinc-600 py-6 text-center">{emptyMessage}</p>
  }

  return (
    <div className={variant === 'page' ? 'space-y-1' : undefined}>
      {notifications.map((notification) => (
        <NotificationFeedItem
          key={notification.id}
          notification={notification}
          onOpen={onOpen}
          variant={variant}
        />
      ))}
    </div>
  )
}

function NotificationFeedItem({ notification, onOpen, variant }: NotificationFeedItemProps) {
  const unread = notification.read_at === null

  if (variant === 'panel') {
    return (
      <button
        type="button"
        className={cn(
          'w-full text-left flex items-start gap-3 px-4 py-3 border-b border-zinc-800 last:border-0 cursor-pointer hover:bg-zinc-800/50 transition-colors',
          unread && 'bg-blue-500/5',
        )}
        onClick={() => onOpen(notification)}
      >
        {unread && <span className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500" />}
        <div className={cn('flex-1 min-w-0', !unread && 'pl-4')}>
          <p className="text-[10px] uppercase tracking-[0.14em] text-blue-300/80">
            {getNotificationTypeLabel(notification.type)}
          </p>
          <p className="text-xs font-medium text-zinc-200 truncate">{notification.title}</p>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{notification.body}</p>
          <p className="text-[10px] text-zinc-700 mt-1">
            {new Date(notification.created_at).toLocaleString()}
          </p>
        </div>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={cn(
        'w-full text-left flex items-start gap-3 px-4 py-3 rounded-lg border transition-colors',
        unread
          ? 'bg-blue-500/5 border-blue-500/20 cursor-pointer hover:bg-blue-500/10'
          : 'bg-zinc-900 border-zinc-800',
      )}
    >
      {unread && <span className="mt-2 shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500" />}
      <div className={cn('flex-1 min-w-0', !unread && 'pl-4')}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-blue-300/80 bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5">
            {getNotificationTypeLabel(notification.type)}
          </span>
        </div>
        <p className="text-sm font-medium text-zinc-200 mt-2">{notification.title}</p>
        <p className="text-sm text-zinc-400 mt-0.5">{notification.body}</p>
        <p className="text-xs text-zinc-600 mt-1">
          {new Date(notification.created_at).toLocaleString()}
        </p>
      </div>
    </button>
  )
}
