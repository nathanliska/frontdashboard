import { Home, LayoutDashboard, Pencil, Star, Trash2 } from 'lucide-react'
import type { DashboardSummary } from '../../api/dashboards'
import { cn } from '../../utils/shared/cn'
import { OverflowMenu, type OverflowMenuItem } from '../ui/OverflowMenu'

export function DashboardCard({
  dashboard,
  currentUserId,
  isHome,
  onOpen,
  onToggleFavorite,
  onSetHome,
  onRename,
  onDelete,
}: {
  dashboard: DashboardSummary
  currentUserId: string | null
  isHome: boolean
  onOpen: () => void
  onToggleFavorite: () => void
  onSetHome: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const isOwned = currentUserId !== null && dashboard.user_id === currentUserId
  const subtitle = dashboard.access_description ?? (isOwned ? 'Owned by you' : 'Shared with you')

  // Actions live in a visible overflow menu (#27) — the old hover-revealed icon row didn't
  // exist on touch. The favorite star stays inline as a state indicator + toggle.
  const menuItems: OverflowMenuItem[] = [
    {
      label: isHome ? 'Home dashboard' : 'Set as home',
      icon: Home,
      onSelect: onSetHome,
      disabled: isHome,
    },
    ...(dashboard.can_edit ? [{ label: 'Edit dashboard', icon: Pencil, onSelect: onRename }] : []),
    {
      label: dashboard.is_favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: Star,
      onSelect: onToggleFavorite,
    },
    // Trash is recoverable, and it is the only put-away state — archive is gone.
    ...(isOwned
      ? [{ label: 'Move to trash', icon: Trash2, onSelect: onDelete, tone: 'danger' as const }]
      : []),
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains real action buttons, so the outer click target cannot itself be a button
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open dashboard ${dashboard.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group flex cursor-pointer flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-zinc-700"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-zinc-500">
          <LayoutDashboard size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-zinc-200 truncate">{dashboard.name}</p>
            {isHome && <Home size={12} className="shrink-0 text-blue-400" fill="currentColor" />}
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onToggleFavorite()
            }}
            title={dashboard.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-md transition-colors sm:h-8 sm:w-8',
              dashboard.is_favorite
                ? 'text-amber-400 hover:text-amber-300'
                : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300',
            )}
          >
            <Star size={14} fill={dashboard.is_favorite ? 'currentColor' : 'none'} />
          </button>
          <OverflowMenu label={`Actions for ${dashboard.name}`} items={menuItems} />
        </div>
      </div>
    </div>
  )
}
