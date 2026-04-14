import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  apiAddDashboardShare,
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
  type DashboardSummary,
} from '../../api/dashboards'
import type { ResourceShare, ShareRole } from '../../api/shares'
import { toast } from '../../stores/toast'
import { cn } from '../../utils/shared/cn'
import { createClientMutationId } from '../../utils/dashboard/dashboardMutation'
import { SharePanel, type SharePanelItem, type ShareRoleOption } from '../ui/SharePanel'

const DASHBOARD_ROLE_OPTIONS: ShareRoleOption[] = [
  {
    value: 'viewer',
    label: 'View',
    description: 'Can open this dashboard and see the widgets and content.',
  },
  {
    value: 'editor',
    label: 'Edit',
    description: 'Can change layout and add or remove widgets.',
  },
]

export function DashboardSettingsModal({
  dashboard,
  onClose,
  onRename,
}: {
  dashboard: Pick<DashboardSummary, 'id' | 'name' | 'can_manage_shares'>
  onClose: () => void
  onRename: (id: string, name: string) => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const [shares, setShares] = useState<ResourceShare[]>([])
  const [sharesLoading, setSharesLoading] = useState(true)

  useEffect(() => {
    if (!dashboard.can_manage_shares) {
      setShares([])
      setSharesLoading(false)
      return
    }

    let cancelled = false
    setSharesLoading(true)

    void apiGetDashboardShares(dashboard.id)
      .then((loadedShares) => {
        if (cancelled) return
        setShares(loadedShares)
      })
      .catch(() => {
        if (cancelled) return
        toast.error('Failed to load dashboard permissions.')
      })
      .finally(() => {
        if (!cancelled) setSharesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [dashboard.can_manage_shares, dashboard.id])

  const shareItems = useMemo<SharePanelItem[]>(
    () =>
      shares.map((share) => ({
        key: `${share.principal_type}:${share.principal_id}`,
        principal_type: share.principal_type,
        principal_id: share.principal_id,
        principal_name: share.principal_name,
        role: share.role,
      })),
    [shares],
  )

  function findShare(item: SharePanelItem) {
    return (
      shares.find(
        (share) =>
          share.principal_type === item.principal_type && share.principal_id === item.principal_id,
      ) ?? null
    )
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const trimmed = String(formData.get('dashboard-name') ?? '').trim()
    if (!trimmed || trimmed === dashboard.name) {
      onClose()
      return
    }

    setSubmitting(true)
    try {
      await onRename(dashboard.id, trimmed)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRoleChange(item: SharePanelItem, role: ShareRole) {
    const share = findShare(item)
    if (!share || share.role === role) return

    const clientMutationId = createClientMutationId()
    try {
      const updated = await apiUpdateDashboardShare(
        dashboard.id,
        share.id,
        { role },
        { clientMutationId },
      )
      setShares((current) => current.map((entry) => (entry.id === share.id ? updated : entry)))
    } catch {
      toast.error('Failed to update permission.')
    }
  }

  async function handleRemoveShare(item: SharePanelItem) {
    const share = findShare(item)
    if (!share) return

    const clientMutationId = createClientMutationId()
    try {
      await apiRemoveDashboardShare(dashboard.id, share.id, { clientMutationId })
      setShares((current) => current.filter((entry) => entry.id !== share.id))
    } catch {
      toast.error('Failed to remove permission.')
    }
  }

  async function handleAddShare(share: {
    principal_type: SharePanelItem['principal_type']
    principal_id: string
    principal_name: string
    role: ShareRole
  }) {
    const clientMutationId = createClientMutationId()
    try {
      const created = await apiAddDashboardShare(
        dashboard.id,
        {
          principal_type: share.principal_type,
          principal_id: share.principal_id,
          role: share.role,
        },
        { clientMutationId },
      )
      setShares((current) => [...current, created])
    } catch {
      toast.error('Failed to add permission.')
    }
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
          <h2 className="text-sm font-semibold text-zinc-100">Dashboard settings</h2>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col max-h-[calc(85vh-57px)]"
        >
          <div className="p-5 space-y-5 overflow-y-auto">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400" htmlFor="dashboard-name">
                Name
              </label>
              <input
                key={`${dashboard.id}:${dashboard.name}`}
                id="dashboard-name"
                name="dashboard-name"
                autoFocus
                defaultValue={dashboard.name}
                placeholder="Dashboard name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>

            {dashboard.can_manage_shares && (
              <SharePanel
                items={shareItems}
                onAdd={handleAddShare}
                onUpdate={handleRoleChange}
                onRemove={handleRemoveShare}
                title="Permissions"
                description="Choose who should be able to view or edit this dashboard."
                emptyMessage="Only you can access this dashboard right now."
                roleOptions={DASHBOARD_ROLE_OPTIONS}
                loading={sharesLoading}
                loadingMessage="Loading permissions…"
              />
            )}
          </div>

          <div className="flex gap-2 p-5 pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={cn(
                'flex-1 py-2 rounded-md text-sm bg-zinc-100 hover:bg-white text-zinc-900 font-medium transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {submitting ? 'Saving…' : 'Save name'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
