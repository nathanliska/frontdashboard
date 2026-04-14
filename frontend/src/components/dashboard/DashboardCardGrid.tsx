import type { DashboardSummary } from '../../api/dashboards'
import { DashboardCard } from './DashboardCard'

export function DashboardCardGrid({
  items,
  homeDashboardId,
  currentUserId,
  onOpen,
  onToggleFavorite,
  onSetHome,
  onRename,
  onDelete,
}: {
  items: DashboardSummary[]
  homeDashboardId: string | null
  currentUserId: string | null
  onOpen: (dashboard: DashboardSummary) => void
  onToggleFavorite: (dashboard: DashboardSummary) => void
  onSetHome: (dashboard: DashboardSummary) => void
  onRename: (dashboard: DashboardSummary) => void
  onDelete: (dashboard: DashboardSummary) => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((dashboard) => (
        <DashboardCard
          key={dashboard.id}
          dashboard={dashboard}
          currentUserId={currentUserId}
          isHome={dashboard.id === homeDashboardId}
          onOpen={() => onOpen(dashboard)}
          onToggleFavorite={() => onToggleFavorite(dashboard)}
          onSetHome={() => onSetHome(dashboard)}
          onRename={() => onRename(dashboard)}
          onDelete={() => onDelete(dashboard)}
        />
      ))}
    </div>
  )
}
