import { ArrowLeft, Pencil, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useEffectEvent, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AddWidgetModal, type AddWidgetParams } from '../components/dashboard/AddWidgetModal'
import { DashboardGrid } from '../components/dashboard/DashboardGrid'
import { DashboardSettingsModal } from '../components/dashboard/DashboardSettingsModal'
import { ROUTES } from '../routes'
import { useDashboardStore } from '../stores/dashboard'

const APP_TITLE = 'FrontDashboard'

export function DashboardEditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const dashboard = useDashboardStore((s) => s.dashboard)
  const loading = useDashboardStore((s) => s.loading)
  const loadError = useDashboardStore((s) => s.loadError)
  const conflict = useDashboardStore((s) => s.conflict)
  const loadDashboard = useDashboardStore((s) => s.loadDashboard)
  const resolveConflict = useDashboardStore((s) => s.resolveConflict)
  const addWidget = useDashboardStore((s) => s.addWidget)
  const renameDashboard = useDashboardStore((s) => s.renameDashboard)
  const [showAddWidget, setShowAddWidget] = useState(false)
  const [showEditDashboard, setShowEditDashboard] = useState(false)
  const closeRestrictedModals = useEffectEvent(() => {
    setShowAddWidget(false)
    setShowEditDashboard(false)
  })

  useEffect(() => {
    if (id) void loadDashboard(id)
  }, [id, loadDashboard])

  useEffect(() => {
    document.title = dashboard?.name || APP_TITLE
    return () => {
      document.title = APP_TITLE
    }
  }, [dashboard?.name])

  useEffect(() => {
    if (!dashboard?.can_edit) {
      closeRestrictedModals()
    }
  }, [dashboard?.can_edit])

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-sm text-zinc-400">Dashboard not found or you don't have access.</p>
        <button
          type="button"
          onClick={() => navigate(ROUTES.dashboards)}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1.5"
        >
          <ArrowLeft size={14} />
          Back to dashboards
        </button>
      </div>
    )
  }

  if (!dashboard) return null

  const canEdit = dashboard.can_edit && !dashboard.archived

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 shrink-0 pl-12 sm:pl-0 min-h-10">
        <button
          type="button"
          onClick={() => navigate(ROUTES.dashboards)}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Back to dashboards"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="min-w-0 flex-1 text-lg sm:text-xl font-semibold text-zinc-100 truncate">
          {dashboard.name}
        </h1>
        {dashboard.is_shared && (
          <div className="order-3 basis-full sm:order-0 sm:basis-auto flex items-center gap-2 text-xs">
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-400">
              Shared
            </span>
            <span className="text-zinc-500 sm:hidden">Same for everyone</span>
            <span className="hidden sm:inline text-zinc-500">
              Everyone with access sees the same widgets, content, and layout.
            </span>
          </div>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowEditDashboard(true)}
            className="rounded-md p-2 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors shrink-0"
            aria-label="Edit dashboard"
            title="Edit dashboard"
          >
            <Pencil size={14} />
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowAddWidget(true)}
            className="ml-auto sm:ml-0 flex items-center gap-1.5 text-xs sm:text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2.5 sm:px-3 py-1.5 rounded-md transition-colors shrink-0"
          >
            <Plus size={14} />
            Add widget
          </button>
        )}
      </div>

      {/* Archived banner */}
      {dashboard.archived && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg shrink-0">
          <p className="text-sm text-amber-400">
            This dashboard is archived. Widgets are read-only until it is unarchived.
          </p>
          <button
            type="button"
            onClick={() => navigate(ROUTES.dashboards)}
            className="text-xs text-amber-400 hover:text-amber-300 transition-colors ml-4 shrink-0"
          >
            Manage
          </button>
        </div>
      )}

      {/* Conflict banner */}
      {conflict && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg shrink-0">
          <p className="text-sm text-amber-400">
            This dashboard was updated elsewhere. Reload to see the latest layout.
          </p>
          <button
            type="button"
            onClick={resolveConflict}
            className="flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 transition-colors ml-4 shrink-0"
          >
            <RefreshCw size={12} />
            Reload
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <DashboardGrid dashboard={dashboard} canEdit={canEdit} />
      </div>

      {showAddWidget && (
        <AddWidgetModal
          dashboardId={dashboard.id}
          existingListIds={dashboard.widgets
            .filter((widget) => widget.resource_type === 'list' && widget.resource_id)
            .map((widget) => widget.resource_id as string)}
          isSharedDashboard={dashboard.is_shared}
          dashboardName={dashboard.name}
          onAdd={async (params: AddWidgetParams) => {
            await addWidget(params)
            setShowAddWidget(false)
          }}
          onClose={() => setShowAddWidget(false)}
        />
      )}

      {showEditDashboard && (
        <DashboardSettingsModal
          dashboard={{
            id: dashboard.id,
            name: dashboard.name,
            can_manage_shares: dashboard.can_manage_shares,
          }}
          onClose={() => setShowEditDashboard(false)}
          onRename={renameDashboard}
        />
      )}
    </div>
  )
}
