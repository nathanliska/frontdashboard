import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
  type DashboardSummary,
} from '../../api/dashboards'
import type { ResourceShare, ShareRole } from '../../api/shares'
import { toast } from '../../stores/toast'
import { cn } from '../../utils/shared/cn'
import { Dialog } from '../ui/Dialog'
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
  onRename: (id: string, name: string) => Promise<boolean>
}) {
  const [submitting, setSubmitting] = useState(false)
  const [shares, setShares] = useState<ResourceShare[]>([])
  const [sharesLoading, setSharesLoading] = useState(true)
  const nameInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

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
      // Keep the modal open (and the typed name intact) if the rename fails.
      if (await onRename(dashboard.id, trimmed)) onClose()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRoleChange(item: SharePanelItem, role: ShareRole) {
    const share = findShare(item)
    if (!share || share.role === role) return

    // Recorded so the dashboard store recognizes the SSE echo as ours — a role change alters
    // nothing the store caches, so recognizing it is what prevents a pointless summaries refetch.
    try {
      const updated = await apiUpdateDashboardShare(dashboard.id, share.id, { role })
      setShares((current) => current.map((entry) => (entry.id === share.id ? updated : entry)))
    } catch {
      toast.error('Failed to update permission.')
    }
  }

  async function handleRemoveShare(item: SharePanelItem) {
    const share = findShare(item)
    if (!share) return
    try {
      await apiRemoveDashboardShare(dashboard.id, share.id)
      setShares((current) => current.filter((entry) => entry.id !== share.id))
    } catch {
      toast.error('Failed to remove permission.')
    }
  }

  return (
    <Dialog title="Dashboard settings" onClose={onClose}>
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
              ref={nameInputRef}
              key={`${dashboard.id}:${dashboard.name}`}
              id="dashboard-name"
              name="dashboard-name"
              defaultValue={dashboard.name}
              placeholder="Dashboard name"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          {dashboard.can_manage_shares && (
            <SharePanel
              dashboardId={dashboard.id}
              items={shareItems}
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
    </Dialog>
  )
}
