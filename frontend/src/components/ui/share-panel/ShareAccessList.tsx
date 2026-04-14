import type { ShareRole } from '../../../api/shares'
import { ShareAccessRow } from './ShareAccessRow'
import type { SharePanelItem, ShareRoleOption } from '../../../utils/share/sharePanelTypes'

export function ShareAccessList({
  items,
  roleOptions,
  busyKey,
  loading,
  loadingMessage,
  emptyMessage,
  currentAccessLabel,
  onUpdate,
  onRemove,
}: {
  items: SharePanelItem[]
  roleOptions: ShareRoleOption[]
  busyKey: string | null
  loading: boolean
  loadingMessage: string
  emptyMessage: string
  currentAccessLabel: string
  onUpdate: (item: SharePanelItem, role: ShareRole) => void | Promise<void>
  onRemove: (item: SharePanelItem) => void | Promise<void>
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-400">{currentAccessLabel}</p>
      {loading ? (
        <div className="text-xs text-zinc-500">{loadingMessage}</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-zinc-600">{emptyMessage}</div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <ShareAccessRow
              key={item.key}
              item={item}
              busy={busyKey === item.key}
              roleOptions={roleOptions}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
