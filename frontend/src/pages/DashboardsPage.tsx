import { LayoutDashboard, Plus, Trash2 } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { DashboardSummary, TrashedDashboard } from '../api/dashboards'
import { CreateDashboardModal } from '../components/dashboard/CreateDashboardModal'
import { DashboardCardGrid } from '../components/dashboard/DashboardCardGrid'
import { DashboardSettingsModal } from '../components/dashboard/DashboardSettingsModal'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'
import { cn } from '../utils/shared/cn'

export function DashboardsPage() {
  const summaries = useDashboardStore((s) => s.summaries)
  const summariesLoading = useDashboardStore((s) => s.summariesLoading)
  const loadSummaries = useDashboardStore((s) => s.loadSummaries)
  const createDashboard = useDashboardStore((s) => s.createDashboard)
  const deleteDashboard = useDashboardStore((s) => s.deleteDashboard)
  const toggleFavorite = useDashboardStore((s) => s.toggleFavorite)
  const renameDashboard = useDashboardStore((s) => s.renameDashboard)
  const trash = useDashboardStore((s) => s.trash)
  const loadTrash = useDashboardStore((s) => s.loadTrash)
  const restoreDashboard = useDashboardStore((s) => s.restoreDashboard)
  const user = useAuthStore((s) => s.user)
  const updatePreferences = useAuthStore((s) => s.updatePreferences)
  const homeDashboardId = user?.preferences?.home_dashboard_id ?? null
  const currentUserId = user?.id ?? null
  const [showCreate, setShowCreate] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [editingDashboardId, setEditingDashboardId] = useState<string | null>(null)
  const navigate = useNavigate()
  const closeEditingDashboard = useEffectEvent(() => {
    setEditingDashboardId(null)
  })

  useEffect(() => {
    void loadSummaries()
  }, [loadSummaries])

  // Lazy, like the lists page: the trash is a rarely-opened view, so it costs a request only
  // when asked for. The store caches it, so toggling repeatedly is free.
  useEffect(() => {
    if (!showTrash) return
    void loadTrash()
  }, [showTrash, loadTrash])

  const editingDashboard = useMemo(
    () =>
      editingDashboardId
        ? (summaries.find((dashboard) => dashboard.id === editingDashboardId) ?? null)
        : null,
    [editingDashboardId, summaries],
  )

  useEffect(() => {
    if (!editingDashboardId) return
    if (!editingDashboard?.can_edit) {
      closeEditingDashboard()
    }
  }, [editingDashboard, editingDashboardId])

  const favorites = useMemo(
    () => summaries.filter((dashboard) => dashboard.is_favorite),
    [summaries],
  )
  const rest = useMemo(() => summaries.filter((dashboard) => !dashboard.is_favorite), [summaries])

  function openDashboard(dashboard: DashboardSummary) {
    navigate(ROUTES.dashboard(dashboard.id))
  }

  function handleToggleFavorite(dashboard: DashboardSummary) {
    void toggleFavorite(dashboard.id, dashboard.is_favorite)
  }

  function handleSetHome(dashboard: DashboardSummary) {
    void updatePreferences({ home_dashboard_id: dashboard.id })
  }

  function handleRename(dashboard: DashboardSummary) {
    setEditingDashboardId(dashboard.id)
  }

  async function handleDelete(dashboard: DashboardSummary) {
    // Honest copy (#40): it goes to the trash with everything on it, and it is recoverable.
    const message = `Move "${dashboard.name}" to the trash? Its lists and calendar events go with it. You can restore it from the trash for 30 days.`
    if (await confirm(message, { confirmLabel: 'Move to trash' })) {
      void deleteDashboard(dashboard.id)
    }
  }

  async function handleRestore(trashed: TrashedDashboard) {
    setRestoringId(trashed.id)
    try {
      if (await restoreDashboard(trashed.id)) {
        toast.success(`Restored "${trashed.name}".`)
      }
    } finally {
      setRestoringId(null)
    }
  }

  function daysUntilPurge(trashed: TrashedDashboard): number {
    return Math.max(0, Math.ceil((new Date(trashed.purge_at).getTime() - Date.now()) / 86_400_000))
  }

  if (summariesLoading && summaries.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full gap-6">
      <div className="flex items-center justify-between gap-3 shrink-0 pl-12 sm:pl-0 min-h-10">
        <h1 className="min-w-0 text-xl font-semibold text-zinc-100 truncate">Dashboards</h1>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTrash((open) => !open)}
            aria-pressed={showTrash}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors sm:text-sm',
              showTrash
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300',
            )}
          >
            <Trash2 size={14} />
            Trash
          </button>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 sm:px-3 sm:text-sm"
          >
            <Plus size={14} />
            Create dashboard
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
        {favorites.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              Favorites
            </h2>
            <DashboardCardGrid
              items={favorites}
              homeDashboardId={homeDashboardId}
              currentUserId={currentUserId}
              onOpen={openDashboard}
              onToggleFavorite={handleToggleFavorite}
              onSetHome={handleSetHome}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </section>
        )}

        {rest.length > 0 && (
          <section>
            {favorites.length > 0 && (
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                All dashboards
              </h2>
            )}
            <DashboardCardGrid
              items={rest}
              homeDashboardId={homeDashboardId}
              currentUserId={currentUserId}
              onOpen={openDashboard}
              onToggleFavorite={handleToggleFavorite}
              onSetHome={handleSetHome}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </section>
        )}

        {showTrash && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              Trash
            </h2>
            {trash.length === 0 ? (
              <p className="text-sm text-zinc-600">Nothing in the trash.</p>
            ) : (
              <div className="space-y-1">
                {trash.map((trashed) => {
                  const days = daysUntilPurge(trashed)
                  return (
                    <div
                      key={trashed.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-300 truncate">{trashed.name}</p>
                        <p className="text-xs text-zinc-600">
                          {days === 0
                            ? 'Will be permanently deleted soon'
                            : `Permanently deleted in ${days} day${days === 1 ? '' : 's'}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRestore(trashed)}
                        disabled={restoringId === trashed.id}
                        className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
                      >
                        {restoringId === trashed.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {summaries.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 text-zinc-600">
            <LayoutDashboard size={32} className="mb-3 opacity-40" />
            <p className="text-sm">No dashboards yet.</p>
            <p className="text-xs mt-1">Create one to get started.</p>
          </div>
        )}
      </div>

      {showCreate && (
        <CreateDashboardModal
          onCreated={(summary) => {
            setShowCreate(false)
            navigate(ROUTES.dashboard(summary.id))
          }}
          onClose={() => setShowCreate(false)}
          createDashboard={createDashboard}
        />
      )}

      {editingDashboard && (
        <DashboardSettingsModal
          dashboard={editingDashboard}
          onClose={() => setEditingDashboardId(null)}
          onRename={renameDashboard}
        />
      )}
    </div>
  )
}
