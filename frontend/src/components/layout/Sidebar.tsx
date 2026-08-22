import {
  CalendarDays,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  User,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ROUTES } from '../../routes'
import { useAuthStore } from '../../stores/auth'
import { isConnectionDegraded, useConnectionStore } from '../../stores/connection'
import { useNotificationsStore } from '../../stores/notifications'
import { useUIStore } from '../../stores/ui'
import { cn } from '../../utils/shared/cn'
import { NotificationPanel } from '../notifications/NotificationPanel'
import { ConnectionDot } from './ConnectionDot'

const NAV = [
  { label: 'Dashboards', icon: LayoutDashboard, to: ROUTES.dashboards },
  { label: 'Calendar', icon: CalendarDays, to: ROUTES.calendar },
  { label: 'Lists', icon: CheckSquare, to: ROUTES.lists },
]

export function Sidebar() {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const mobileSidebarOpen = useUIStore((s) => s.mobileSidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const closeMobileSidebar = useUIStore((s) => s.closeMobileSidebar)
  const location = useLocation()
  const loadUnreadCount = useNotificationsStore((s) => s.loadUnreadCount)
  const setPanelOpen = useNotificationsStore((s) => s.setPanelOpen)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  useEffect(() => {
    void loadUnreadCount()
  }, [loadUnreadCount])

  const handleUserMenuOpenChange = useCallback(
    (next: boolean) => {
      if (next) setPanelOpen(false)
      setUserMenuOpen(next)
    },
    [setPanelOpen],
  )

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity nav:hidden',
          mobileSidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={closeMobileSidebar}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 nav:relative nav:z-20 nav:h-dvh nav:shrink-0 nav:transition-all',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full nav:translate-x-0',
          sidebarCollapsed ? 'nav:w-16' : 'nav:w-56',
        )}
      >
        {/* Logo + collapse toggle */}
        <div className="flex items-center h-14 border-b border-zinc-800 px-3 gap-2">
          {(!sidebarCollapsed || mobileSidebarOpen) && (
            <span className="flex-1 text-sm font-semibold text-zinc-100 tracking-wide pl-1 truncate">
              FrontDashboard
            </span>
          )}
          <button
            type="button"
            onClick={mobileSidebarOpen ? closeMobileSidebar : toggleSidebar}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            aria-label={
              mobileSidebarOpen
                ? 'Close navigation'
                : sidebarCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
            }
          >
            {mobileSidebarOpen ? (
              <ChevronLeft size={16} />
            ) : sidebarCollapsed ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        </div>

        {/* Primary nav */}
        <nav className="flex-1 py-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ label, icon: Icon, to }) => {
            const active =
              to === '/dashboards'
                ? location.pathname === '/' || location.pathname.startsWith('/dashboard')
                : location.pathname === to
            return (
              <Link
                key={to}
                to={to}
                title={sidebarCollapsed && !mobileSidebarOpen ? label : undefined}
                onClick={closeMobileSidebar}
                className={cn(
                  'flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm transition-colors',
                  active
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                )}
              >
                <Icon size={18} className="shrink-0" />
                {(!sidebarCollapsed || mobileSidebarOpen) && <span>{label}</span>}
              </Link>
            )
          })}
        </nav>

        {/* Bottom: bell + user menu */}
        <div className="border-t border-zinc-800 py-2 space-y-0.5">
          <NotificationPanel
            collapsed={sidebarCollapsed && !mobileSidebarOpen}
            onOpen={() => setUserMenuOpen(false)}
          />
          <UserMenu
            collapsed={sidebarCollapsed && !mobileSidebarOpen}
            open={userMenuOpen}
            onOpenChange={handleUserMenuOpenChange}
            closeMobileSidebar={closeMobileSidebar}
          />
        </div>
      </aside>
    </>
  )
}

function UserMenu({
  collapsed,
  open,
  onOpenChange,
  closeMobileSidebar,
}: {
  collapsed: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  closeMobileSidebar: () => void
}) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const connectionStatus = useConnectionStore((s) => s.status)
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        onOpenChange(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open, onOpenChange])

  async function handleSignOut() {
    onOpenChange(false)
    closeMobileSidebar()
    await logout()
    navigate(ROUTES.login, { replace: true })
  }

  const initial = user?.display_name?.[0]?.toUpperCase() ?? '?'
  const displayName = user?.display_name ?? 'Account'
  const degraded = isConnectionDegraded(connectionStatus)
  // The dot means nothing to someone seeing it for the first time, so give it words on hover.
  let accountTitle: string | undefined
  if (degraded) accountTitle = `${displayName} — reconnecting, live updates are paused`
  else if (collapsed) accountTitle = displayName

  return (
    <div ref={containerRef} className="relative z-50">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={accountTitle}
        className="relative z-50 flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors w-[calc(100%-16px)]"
      >
        <div className="relative shrink-0 w-4.5 h-4.5 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-[10px] font-semibold">
          {initial}
          <ConnectionDot className="-bottom-0.5 -right-0.5" />
        </div>
        {!collapsed && <span className="flex-1 text-left truncate">{displayName}</span>}
        {degraded && <span className="sr-only">Reconnecting — live updates are paused</span>}
      </button>

      {open && (
        <div
          className={cn(
            'absolute bottom-full mb-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl py-1 z-50 min-w-44 text-sm',
            collapsed ? 'left-full ml-2' : 'left-2',
          )}
        >
          <MenuItem
            icon={User}
            label="Profile"
            onClick={() => {
              onOpenChange(false)
              closeMobileSidebar()
              navigate(ROUTES.profile)
            }}
          />
          <hr className="border-zinc-800 my-1" />
          <MenuItem icon={LogOut} label="Sign out" danger onClick={handleSignOut} />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ElementType
  label: string
  danger?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2 transition-colors text-left',
        danger
          ? 'text-zinc-400 hover:text-red-400 hover:bg-zinc-800'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800',
      )}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </button>
  )
}
