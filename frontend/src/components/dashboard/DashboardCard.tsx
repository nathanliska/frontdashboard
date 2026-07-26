import { Archive, Home, LayoutDashboard, Pencil, Star, Trash2, Undo2 } from 'lucide-react'
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
  onArchive,
  onDelete,
}: {
  dashboard: DashboardSummary
  currentUserId: string | null
  isHome: boolean
  onOpen: () => void
  onToggleFavorite: () => void
  onSetHome: () => void
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const isOwned = currentUserId !== null && dashboard.user_id === currentUserId
  const subtitle = dashboard.access_description ?? (isOwned ? 'Owned by you' : 'Shared with you')
  const isArchived = dashboard.archived

  // Actions live in a visible overflow menu (#27) — the old hover-revealed icon row didn't
  // exist on touch. The favorite star stays inline as a state indicator + toggle.
  const menuItems: OverflowMenuItem[] = [
    {
      label: isHome ? 'Home dashboard' : 'Set as home',
      icon: Home,
      onSelect: onSetHome,
      disabled: isArchived || isHome,
    },
    ...(dashboard.can_edit
      ? [{ label: 'Edit dashboard', icon: Pencil, onSelect: onRename, disabled: isArchived }]
      : []),
    {
      label: dashboard.is_favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: Star,
      onSelect: onToggleFavorite,
      disabled: isArchived,
    },
    ...(isOwned
      ? [
          {
            label: isArchived ? 'Unarchive' : 'Archive',
            icon: isArchived ? Undo2 : Archive,
            onSelect: onArchive,
          },
          // Trash is recoverable (#40), so it no longer hides behind archive-first.
          { label: 'Move to trash', icon: Trash2, onSelect: onDelete, tone: 'danger' as const },
        ]
      : []),
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains real action buttons, so the outer click target cannot itself be a button
    <div
      role="button"
      tabIndex={isArchived ? -1 : 0}
      aria-disabled={isArchived}
      aria-label={`Open dashboard ${dashboard.name}`}
      onClick={() => {
        if (!isArchived) onOpen()
      }}
      onKeyDown={(event) => {
        if (isArchived) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'group flex flex-col gap-2 p-4 bg-zinc-900 border border-zinc-800 rounded-lg transition-colors',
        isArchived ? 'opacity-75 cursor-default' : 'cursor-pointer hover:border-zinc-700',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-zinc-500">
          <LayoutDashboard size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-zinc-200 truncate">{dashboard.name}</p>
            {isHome && !isArchived && (
              <Home size={12} className="shrink-0 text-blue-400" fill="currentColor" />
            )}
            {isArchived && (
              <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                Archived
              </span>
            )}
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
            disabled={isArchived}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-md transition-colors sm:h-8 sm:w-8',
              'disabled:opacity-30 disabled:cursor-not-allowed',
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
