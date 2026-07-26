import { LayoutDashboard, Plus } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  apiGetTrash,
  apiRestoreDashboard,
  type DashboardSummary,
  type TrashedDashboard,
} from '../api/dashboards'
import { CreateDashboardModal } from '../components/dashboard/CreateDashboardModal'
import { DashboardCardGrid } from '../components/dashboard/DashboardCardGrid'
import { DashboardSettingsModal } from '../components/dashboard/DashboardSettingsModal'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'

export function DashboardsPage() {
  const summaries = useDashboardStore((s) => s.summaries)
  const summariesLoading = useDashboardStore((s) => s.summariesLoading)
  const loadSummaries = useDashboardStore((s) => s.loadSummaries)
  const createDashboard = useDashboardStore((s) => s.createDashboard)
  const archiveDashboard = useDashboardStore((s) => s.archiveDashboard)
  const deleteDashboard = useDashboardStore((s) => s.deleteDashboard)
  const toggleFavorite = useDashboardStore((s) => s.toggleFavorite)
  const renameDashboard = useDashboardStore((s) => s.renameDashboard)
  const user = useAuthStore((s) => s.user)
  const updatePreferences = useAuthStore((s) => s.updatePreferences)
  const homeDashboardId = user?.preferences?.home_dashboard_id ?? null
  const currentUserId = user?.id ?? null
  const [showCreate, setShowCreate] = useState(false)
  const [trash, setTrash] = useState<TrashedDashboard[]>([])
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [editingDashboardId, setEditingDashboardId] = useState<string | null>(null)
  const navigate = useNavigate()
  const closeEditingDashboard = useEffectEvent(() => {
    setEditingDashboardId(null)
  })

  useEffect(() => {
    void loadSummaries()
  }, [loadSummaries])

  useEffect(() => {
    // Best-effort: the trash section simply doesn't render if this fails — the primary listing
    // must not couple to it.
    void apiGetTrash()
      .then(setTrash)
      .catch(() => setTrash([]))
  }, [])

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
    () => summaries.filter((dashboard) => !dashboard.archived && dashboard.is_favorite),
    [summaries],
  )
  const rest = useMemo(
    () => summaries.filter((dashboard) => !dashboard.archived && !dashboard.is_favorite),
    [summaries],
  )
  const archived = useMemo(() => summaries.filter((dashboard) => dashboard.archived), [summaries])

  function openDashboard(dashboard: DashboardSummary) {
    navigate(ROUTES.dashboard(dashboard.id))
  }

  function handleToggleFavorite(dashboard: DashboardSummary) {
    if (dashboard.archived) return
    void toggleFavorite(dashboard.id, dashboard.is_favorite)
  }

  function handleSetHome(dashboard: DashboardSummary) {
    if (dashboard.archived) return
    void updatePreferences({ home_dashboard_id: dashboard.id })
  }

  function handleRename(dashboard: DashboardSummary) {
    setEditingDashboardId(dashboard.id)
  }

  async function handleArchive(dashboard: DashboardSummary) {
    const message = dashboard.archived
      ? `Unarchive "${dashboard.name}"?`
      : `Archive "${dashboard.name}"? Its lists and calendar views will disappear until you restore it.`
    if (await confirm(message)) {
      void archiveDashboard(dashboard.id, !dashboard.archived)
    }
  }

  async function handleDelete(dashboard: DashboardSummary) {
    // Honest copy (#40): it goes to the trash with everything on it, and it is recoverable.
    const message = `Move "${dashboard.name}" to the trash? Its lists and calendar events go with it. You can restore it from the trash for 30 days.`
    if (await confirm(message)) {
      if (await deleteDashboard(dashboard.id)) {
        void apiGetTrash()
          .then(setTrash)
          .catch(() => undefined)
      }
    }
  }

  async function handleRestore(trashed: TrashedDashboard) {
    setRestoringId(trashed.id)
    try {
      await apiRestoreDashboard(trashed.id)
      setTrash((current) => current.filter((t) => t.id !== trashed.id))
      await loadSummaries()
      toast.success(`Restored "${trashed.name}".`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore dashboard.')
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
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="shrink-0 flex items-center gap-1.5 text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2.5 sm:px-3 py-1.5 rounded-md transition-colors"
        >
          <Plus size={14} />
          Create dashboard
        </button>
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
              onArchive={handleArchive}
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
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
          </section>
        )}

        {trash.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              Trash
            </h2>
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
          </section>
        )}

        {archived.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              Archived
            </h2>
            <DashboardCardGrid
              items={archived}
              homeDashboardId={homeDashboardId}
              currentUserId={currentUserId}
              onOpen={openDashboard}
              onToggleFavorite={handleToggleFavorite}
              onSetHome={handleSetHome}
              onRename={handleRename}
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
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
