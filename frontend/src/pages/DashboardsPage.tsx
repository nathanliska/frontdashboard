import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Home, LayoutDashboard, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import type { DashboardSummary } from '../api/dashboards'
import type { ShareCreate, ShareRole } from '../api/shares'
import { DashboardSettingsModal } from '../components/dashboard/DashboardSettingsModal'
import { SharePanel, type SharePanelItem, type ShareRoleOption } from '../components/ui/SharePanel'
import { useAuthStore } from '../stores/auth'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import { cn } from '../utils/cn'

type DraftShare = ShareCreate & { principal_name: string }

const DASHBOARD_ROLE_OPTIONS: ShareRoleOption[] = [
  {
    value: 'viewer',
    label: 'View',
    description: 'Can open this dashboard and see the widgets and content.',
  },
  {
    value: 'editor',
    label: 'Edit',
    description: 'Can change layout, add or remove widgets.',
  },
]

export function DashboardsPage() {
  const {
    summaries,
    summariesLoading,
    loadSummaries,
    createDashboard,
    deleteDashboard,
    toggleFavorite,
    renameDashboard,
  } = useDashboardStore()
  const { user, updatePreferences } = useAuthStore()
  const homeDashboardId = user?.preferences?.home_dashboard_id ?? null
  const currentUserId = user?.id ?? null
  const [showCreate, setShowCreate] = useState(false)
  const [editingDashboardId, setEditingDashboardId] = useState<string | null>(null)
  const navigate = useNavigate()
  const closeEditingDashboard = useEffectEvent(() => {
    setEditingDashboardId(null)
  })

  useEffect(() => {
    void loadSummaries()
  }, [loadSummaries])

  const editingDashboard = useMemo(
    () =>
      editingDashboardId
        ? (summaries.find((dashboard) => dashboard.id === editingDashboardId) ?? null)
        : null,
    [editingDashboardId, summaries],
  )

  useEffect(() => {
    if (!editingDashboardId) return
    if (!editingDashboard || !editingDashboard.can_edit) {
      closeEditingDashboard()
    }
  }, [editingDashboard, editingDashboardId])

  const favorites = summaries.filter((dashboard) => dashboard.is_favorite)
  const rest = summaries.filter((dashboard) => !dashboard.is_favorite)

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
            <DashboardGrid
              items={favorites}
              homeDashboardId={homeDashboardId}
              currentUserId={currentUserId}
              onOpen={(id) => navigate(`/dashboard/${id}`)}
              onToggleFavorite={(dashboard) =>
                void toggleFavorite(dashboard.id, dashboard.is_favorite)
              }
              onSetHome={(dashboard) => void updatePreferences({ home_dashboard_id: dashboard.id })}
              onRename={(dashboard) => setEditingDashboardId(dashboard.id)}
              onDelete={async (dashboard) => {
                if (await confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) {
                  void deleteDashboard(dashboard.id)
                }
              }}
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
            <DashboardGrid
              items={rest}
              homeDashboardId={homeDashboardId}
              currentUserId={currentUserId}
              onOpen={(id) => navigate(`/dashboard/${id}`)}
              onToggleFavorite={(dashboard) =>
                void toggleFavorite(dashboard.id, dashboard.is_favorite)
              }
              onSetHome={(dashboard) => void updatePreferences({ home_dashboard_id: dashboard.id })}
              onRename={(dashboard) => setEditingDashboardId(dashboard.id)}
              onDelete={async (dashboard) => {
                if (await confirm(`Delete "${dashboard.name}"? This cannot be undone.`)) {
                  void deleteDashboard(dashboard.id)
                }
              }}
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
            navigate(`/dashboard/${summary.id}`)
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

function DashboardGrid({
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
  onOpen: (id: string) => void
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
          onOpen={() => onOpen(dashboard.id)}
          onToggleFavorite={() => onToggleFavorite(dashboard)}
          onSetHome={() => onSetHome(dashboard)}
          onRename={() => onRename(dashboard)}
          onDelete={() => onDelete(dashboard)}
        />
      ))}
    </div>
  )
}

function DashboardCard({
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

function CreateDashboardModal({
  onCreated,
  onClose,
  createDashboard,
}: {
  onCreated: (summary: DashboardSummary) => void
  onClose: () => void
  createDashboard: (data: { name: string; shares?: ShareCreate[] }) => Promise<DashboardSummary>
}) {
  const [name, setName] = useState('')
  const [draftShares, setDraftShares] = useState<DraftShare[]>([])
  const [submitting, setSubmitting] = useState(false)

  const shareItems = useMemo<SharePanelItem[]>(
    () =>
      draftShares.map((share) => ({
        key: `${share.principal_type}:${share.principal_id}`,
        principal_type: share.principal_type,
        principal_id: share.principal_id,
        principal_name: share.principal_name,
        role: share.role,
      })),
    [draftShares],
  )

  async function handleSubmit(event: React.SyntheticEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const summary = await createDashboard({
        name: name.trim(),
        shares: draftShares.map((share) => ({
          principal_id: share.principal_id,
          principal_type: share.principal_type,
          role: share.role,
        })),
      })
      onCreated(summary)
    } finally {
      setSubmitting(false)
    }
  }

  function updateDraftRole(item: SharePanelItem, role: ShareRole) {
    setDraftShares((current) =>
      current.map((share) =>
        share.principal_type === item.principal_type && share.principal_id === item.principal_id
          ? { ...share, role }
          : share,
      ),
    )
  }

  function removeDraft(item: SharePanelItem) {
    setDraftShares((current) =>
      current.filter(
        (share) =>
          !(
            share.principal_type === item.principal_type && share.principal_id === item.principal_id
          ),
      ),
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Create dashboard</h2>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col max-h-[calc(85vh-57px)]"
        >
          <div className="p-5 space-y-5 overflow-y-auto">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Name</label>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My Dashboard"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <SharePanel
              items={shareItems}
              title="Initial access"
              description="Choose who should be able to view, use widgets on, or edit this dashboard."
              emptyMessage="This dashboard will start private to you."
              roleOptions={DASHBOARD_ROLE_OPTIONS}
              onAdd={({ principal_id, principal_name, principal_type, role }) => {
                setDraftShares((current) => [
                  ...current,
                  { principal_id, principal_name, principal_type, role },
                ])
              }}
              onUpdate={async (item, role) => {
                updateDraftRole(item, role)
              }}
              onRemove={async (item) => {
                removeDraft(item)
              }}
            />
            {draftShares.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                <p className="text-xs text-zinc-500">
                  People you add here will be able to open this dashboard as soon as it is created.
                  Any shared widgets you place on it later will follow this dashboard audience.
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2 p-5 pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="flex-1 py-2 rounded-md text-sm bg-zinc-100 hover:bg-white text-zinc-900 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
