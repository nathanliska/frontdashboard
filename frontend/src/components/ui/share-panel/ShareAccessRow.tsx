import { Trash2 } from 'lucide-react'
import { memo } from 'react'
import type { ShareRole } from '../../../api/shares'
import type { SharePanelItem, ShareRoleOption } from '../../../utils/share/sharePanelTypes'

export const ShareAccessRow = memo(function ShareAccessRow({
  item,
  busy,
  roleOptions,
  onUpdate,
  onRemove,
}: {
  item: SharePanelItem
  busy: boolean
  roleOptions: ShareRoleOption[]
  onUpdate: (item: SharePanelItem, role: ShareRole) => void | Promise<void>
  onRemove: (item: SharePanelItem) => void | Promise<void>
}) {
  return (
    <li className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-200 truncate">{item.principal_name}</p>
        <p className="text-xs text-zinc-500">Person</p>
      </div>
      <select
        value={item.role}
        onChange={(event) => void onUpdate(item, event.target.value as ShareRole)}
        disabled={busy}
        className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700 disabled:opacity-50"
      >
        {roleOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void onRemove(item)}
        disabled={busy}
        className="rounded-md p-2 text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
        aria-label={`Remove ${item.principal_name}`}
        title="Remove access"
      >
        <Trash2 size={14} />
      </button>
    </li>
  )
})
