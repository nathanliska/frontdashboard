import { Archive, Home, LayoutDashboard, Pencil, Star, Trash2, Undo2 } from 'lucide-react'
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

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 p-4 bg-zinc-900 border border-zinc-800 rounded-lg transition-colors',
        isArchived ? 'opacity-75 cursor-default' : 'hover:border-zinc-700',
      )}
    >
      {!isArchived && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open dashboard ${dashboard.name}`}
          className="absolute inset-0 rounded-lg"
        />
      )}
      <div className="relative flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-zinc-500">
          <LayoutDashboard size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-zinc-200 truncate">{dashboard.name}</p>
            {isArchived && (
              <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                Archived
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="relative flex items-center gap-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onSetHome()
          }}
          title={isHome ? 'Home dashboard' : 'Set as home'}
          disabled={isArchived}
          className={cn(
            'p-1.5 rounded transition-colors',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            isHome
              ? 'text-blue-400'
              : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-400',
          )}
        >
          <Home size={13} fill={isHome ? 'currentColor' : 'none'} />
        </button>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onRename()
          }}
          title="Edit dashboard"
          disabled={isArchived}
          className={cn(
            'p-1.5 rounded text-zinc-600 hover:text-zinc-300 transition-colors',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            dashboard.can_edit ? 'opacity-0 group-hover:opacity-100' : 'hidden',
          )}
        >
          <Pencil size={13} />
        </button>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleFavorite()
          }}
          title={dashboard.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          disabled={isArchived}
          className={cn(
            'p-1.5 rounded transition-colors',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            dashboard.is_favorite
              ? 'text-amber-400 hover:text-amber-300'
              : 'opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-400',
          )}
        >
          <Star size={13} fill={dashboard.is_favorite ? 'currentColor' : 'none'} />
        </button>

        {isOwned && (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onArchive()
              }}
              title={isArchived ? 'Unarchive dashboard' : 'Archive dashboard'}
              className={cn(
                'opacity-0 group-hover:opacity-100 p-1.5 rounded transition-colors',
                isArchived
                  ? 'text-amber-400 hover:text-amber-300'
                  : 'text-zinc-600 hover:text-amber-300',
              )}
            >
              {isArchived ? <Undo2 size={13} /> : <Archive size={13} />}
            </button>

            {isArchived && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete()
                }}
                title="Delete dashboard permanently"
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-zinc-600 hover:text-red-400 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
