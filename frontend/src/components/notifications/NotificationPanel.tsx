import { Bell, Check, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router'
import { ROUTES } from '../../routes'
import { useNotificationsStore } from '../../stores/notifications'
import { getNotificationDestination } from '../../utils/notifications/notificationFeedUtils'
import { cn } from '../../utils/shared/cn'
import { NotificationFeed } from './NotificationFeed'

export function NotificationPanel({
  collapsed,
  onOpen,
}: {
  collapsed: boolean
  onOpen?: () => void
}) {
  const navigate = useNavigate()
  const notifications = useNotificationsStore((s) => s.notifications)
  const unreadCount = useNotificationsStore((s) => s.unreadCount)
  const panelOpen = useNotificationsStore((s) => s.panelOpen)
  const setPanelOpen = useNotificationsStore((s) => s.setPanelOpen)
  const markRead = useNotificationsStore((s) => s.markRead)
  const markAllRead = useNotificationsStore((s) => s.markAllRead)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!panelOpen) return
    function handleMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [panelOpen, setPanelOpen])

  function handleNotificationClick(notification: (typeof notifications)[number]) {
    if (notification.read_at === null) {
      void markRead(notification.id)
    }
    setPanelOpen(false)
    const destination = getNotificationDestination(notification)
    if (destination) {
      navigate(destination)
    }
  }

  return (
    <div ref={containerRef} className="relative z-50">
      {/* Bell trigger */}
      <button
        type="button"
        onClick={() => {
          if (!panelOpen) onOpen?.()
          setPanelOpen(!panelOpen)
        }}
        title={collapsed ? 'Notifications' : undefined}
        className="relative z-50 flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors w-[calc(100%-16px)]"
      >
        <div className="relative shrink-0">
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
        {!collapsed && <span>Notifications</span>}
      </button>

      {/* Slide-out panel */}
      {panelOpen && (
        <div
          className={cn(
            'absolute bottom-full mb-1 w-80 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl z-50 flex flex-col max-h-120',
            collapsed ? 'left-full ml-2' : 'left-2',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
            <span className="text-sm font-medium text-zinc-100">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
                >
                  <Check size={11} />
                  Mark all read
                </button>
              )}
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            <NotificationFeed
              notifications={notifications}
              emptyMessage="No notifications"
              onOpen={handleNotificationClick}
              variant="panel"
            />
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-zinc-800 shrink-0">
            <Link
              to={ROUTES.notifications}
              onClick={() => setPanelOpen(false)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              View all notifications →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
