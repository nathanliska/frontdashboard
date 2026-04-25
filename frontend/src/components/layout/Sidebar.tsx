import {
  CalendarDays,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Settings,
  User,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ROUTES } from '../../routes'
import { useAuthStore } from '../../stores/auth'
import { useNotificationsStore } from '../../stores/notifications'
import { useUIStore } from '../../stores/ui'
import { cn } from '../../utils/shared/cn'
import { NotificationPanel } from '../notifications/NotificationPanel'

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

  useEffect(() => {
    void loadUnreadCount()
  }, [loadUnreadCount])

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity sm:hidden',
          mobileSidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={closeMobileSidebar}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-zinc-800 bg-zinc-950 transition-transform duration-200 sm:relative sm:z-20 sm:h-screen sm:shrink-0 sm:transition-all',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0',
          sidebarCollapsed ? 'sm:w-16' : 'sm:w-56',
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
          <NotificationPanel collapsed={sidebarCollapsed && !mobileSidebarOpen} />
          <UserMenu
            collapsed={sidebarCollapsed && !mobileSidebarOpen}
            closeMobileSidebar={closeMobileSidebar}
          />
        </div>
      </aside>
    </>
  )
}

function UserMenu({
  collapsed,
  closeMobileSidebar,
}: {
  collapsed: boolean
  closeMobileSidebar: () => void
}) {
  const [open, setOpen] = useState(false)
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()

  async function handleSignOut() {
    setOpen(false)
    closeMobileSidebar()
    await logout()
    navigate(ROUTES.login, { replace: true })
  }

  const initial = user?.display_name?.[0]?.toUpperCase() ?? '?'
  const displayName = user?.display_name ?? 'Account'

  return (
    <div className="relative z-50">
      {open && (
        <button
          type="button"
          aria-label="Close account menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default bg-transparent"
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={collapsed ? displayName : undefined}
        className="relative z-50 flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors w-[calc(100%-16px)]"
      >
        <div className="shrink-0 w-4.5 h-4.5 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 text-[10px] font-semibold">
          {initial}
        </div>
        {!collapsed && <span className="flex-1 text-left truncate">{displayName}</span>}
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
              setOpen(false)
              closeMobileSidebar()
              navigate(ROUTES.profile)
            }}
          />
          <MenuItem
            icon={Settings}
            label="Preferences"
            onClick={() => {
              setOpen(false)
              closeMobileSidebar()
              navigate(ROUTES.preferences)
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
