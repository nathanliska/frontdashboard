import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Bell, Check, X } from 'lucide-react'
import { useNotificationsStore } from '../../stores/notifications'
import { cn } from '../../utils/cn'

export function NotificationPanel({ collapsed }: { collapsed: boolean }) {
  const { notifications, unreadCount, panelOpen, setPanelOpen, markRead, markAllRead } =
    useNotificationsStore()
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!panelOpen) return
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [panelOpen, setPanelOpen])

  return (
    <div ref={panelRef} className="relative">
      {/* Bell trigger */}
      <button
        onClick={() => setPanelOpen(!panelOpen)}
        title={collapsed ? 'Notifications' : undefined}
        className="flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors w-[calc(100%-16px)]"
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
        <div className="absolute bottom-full left-full ml-2 mb-0 w-80 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl z-50 flex flex-col max-h-[480px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
            <span className="text-sm font-medium text-zinc-100">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={() => void markAllRead()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
                >
                  <Check size={11} />
                  Mark all read
                </button>
              )}
              <button
                onClick={() => setPanelOpen(false)}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <p className="text-sm text-zinc-600 px-4 py-6 text-center">No notifications</p>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 border-b border-zinc-800 last:border-0 cursor-pointer hover:bg-zinc-800/50 transition-colors',
                    n.read_at === null && 'bg-blue-500/5',
                  )}
                  onClick={() => {
                    if (n.read_at === null) void markRead(n.id)
                  }}
                >
                  {n.read_at === null && (
                    <span className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full bg-blue-500" />
                  )}
                  <div className={cn('flex-1 min-w-0', n.read_at !== null && 'pl-4')}>
                    <p className="text-xs font-medium text-zinc-200 truncate">{n.title}</p>
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">{n.body}</p>
                    <p className="text-[10px] text-zinc-700 mt-1">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-zinc-800 shrink-0">
            <Link
              to="/notifications"
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
