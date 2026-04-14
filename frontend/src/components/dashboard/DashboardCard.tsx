import { Home, LayoutDashboard, Pencil, Star, Trash2 } from 'lucide-react'
import type { DashboardSummary } from '../../api/dashboards'
import { cn } from '../../utils/shared/cn'

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

  return (
    <div
      onClick={onOpen}
      className="group flex flex-col gap-3 p-4 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-700 cursor-pointer transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-zinc-500">
          <LayoutDashboard size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-200 truncate">{dashboard.name}</p>
          <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={(event) => {
            event.stopPropagation()
            onSetHome()
          }}
          title={isHome ? 'Home dashboard' : 'Set as home'}
          className={cn(
            'p-1.5 rounded transition-colors',
            isHome
              ? 'text-blue-400'
              : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-400',
          )}
        >
          <Home size={13} fill={isHome ? 'currentColor' : 'none'} />
        </button>

        <button
          onClick={(event) => {
            event.stopPropagation()
            onRename()
          }}
          title="Edit dashboard"
          className={cn(
            'p-1.5 rounded text-zinc-600 hover:text-zinc-300 transition-colors',
            dashboard.can_edit ? 'opacity-0 group-hover:opacity-100' : 'hidden',
          )}
        >
          <Pencil size={13} />
        </button>

        <button
          onClick={(event) => {
            event.stopPropagation()
            onToggleFavorite()
          }}
          title={dashboard.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          className={cn(
            'p-1.5 rounded transition-colors',
            dashboard.is_favorite
              ? 'text-amber-400 hover:text-amber-300'
              : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-400',
          )}
        >
          <Star size={13} fill={dashboard.is_favorite ? 'currentColor' : 'none'} />
        </button>

        {isOwned && (
          <button
            onClick={(event) => {
              event.stopPropagation()
              onDelete()
            }}
            title="Delete dashboard"
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-zinc-600 hover:text-red-400 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
