import { Users } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { ShareRole } from '../../api/shares'
import type { SharePanelItem, ShareRoleOption } from '../../utils/share/sharePanelTypes'
import { capitalize } from '../../utils/shared/cn'
import { ShareAccessList } from './share-panel/ShareAccessList'
import { SharePanelInvite } from './share-panel/SharePanelInvite'

export type { SharePanelItem, ShareRoleOption } from '../../utils/share/sharePanelTypes'
/** @knipignore Retained scaffolding — see the declaration for why nothing mounts it yet. */
export { DashboardManagedAccessList } from './share-panel/DashboardManagedAccessList'

const DEFAULT_SHARE_ROLE_OPTIONS: ShareRoleOption[] = (
  ['viewer', 'editor'] as const satisfies readonly ShareRole[]
).map((role) => ({
  value: role,
  label: formatRole(role),
}))

export function SharePanel({
  dashboardId,
  items,
  onUpdate,
  onRemove,
  title = 'Permissions',
  description = 'Share this resource with people.',
  emptyMessage = 'Only you can access this right now.',
  roleOptions,
  currentAccessLabel = 'Current access',
  loading = false,
  loadingMessage = 'Loading permissions…',
}: {
  /** Access is granted by handing out an invite link, so the panel needs the dashboard it manages. */
  dashboardId: string
  items: SharePanelItem[]
  onUpdate: (item: SharePanelItem, role: ShareRole) => void | Promise<void>
  onRemove: (item: SharePanelItem) => void | Promise<void>
  title?: string
  description?: string
  emptyMessage?: string
  roleOptions?: ShareRoleOption[]
  currentAccessLabel?: string
  loading?: boolean
  loadingMessage?: string
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const effectiveRoleOptions = roleOptions ?? DEFAULT_SHARE_ROLE_OPTIONS

  const handleUpdate = useCallback(
    async (item: SharePanelItem, role: ShareRole) => {
      if (item.role === role) return
      setBusyKey(item.key)
      try {
        await onUpdate(item, role)
      } finally {
        setBusyKey(null)
      }
    },
    [onUpdate],
  )

  const handleRemove = useCallback(
    async (item: SharePanelItem) => {
      setBusyKey(item.key)
      try {
        await onRemove(item)
      } finally {
        setBusyKey(null)
      }
    },
    [onRemove],
  )

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Users size={14} className="text-zinc-500" />
        <div>
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-3">
        <SharePanelInvite dashboardId={dashboardId} roleOptions={effectiveRoleOptions} />

        <ShareAccessList
          items={items}
          roleOptions={effectiveRoleOptions}
          busyKey={busyKey}
          loading={loading}
          loadingMessage={loadingMessage}
          emptyMessage={emptyMessage}
          currentAccessLabel={currentAccessLabel}
          onUpdate={handleUpdate}
          onRemove={handleRemove}
        />
      </div>
    </section>
  )
}

function formatRole(role: ShareRole): string {
  return capitalize(role)
}
