import { Copy, Link2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  apiCreateInvite,
  apiGetInvites,
  apiRevokeInvite,
  type DashboardInvite,
} from '../../../api/invites'
import type { ShareRole } from '../../../api/shares'
import { toast } from '../../../stores/toast'
import type { ShareRoleOption } from '../../../utils/share/sharePanelTypes'

function inviteUrl(code: string): string {
  return `${window.location.origin}/invite/${code}`
}

function expiryLabel(expiresAt: string): string {
  const days = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 86_400_000))
  if (days === 0) return 'expires today'
  return `expires in ${days} day${days === 1 ? '' : 's'}`
}

/**
 * Creates and manages invite links for a dashboard. There is no people search: the only way to
 * grant access is to hand someone a link, so nothing here can be used to discover who exists.
 *
 * A freshly minted code is shown once and never again — the server only stores its hash — so the
 * new link stays on screen until it is dismissed.
 */
export function SharePanelInvite({
  dashboardId,
  roleOptions,
}: {
  dashboardId: string
  roleOptions: ShareRoleOption[]
}) {
  const [role, setRole] = useState<ShareRole>('viewer')
  const [invites, setInvites] = useState<DashboardInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [freshLink, setFreshLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const selectedRoleOption = roleOptions.find((option) => option.value === role)

  const reload = useCallback(async () => {
    try {
      setInvites(await apiGetInvites(dashboardId))
    } catch {
      // The panel's primary job is the access list; a failed invite fetch shouldn't blank it.
    } finally {
      setLoading(false)
    }
  }, [dashboardId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleCreate() {
    setCreating(true)
    try {
      const invite = await apiCreateInvite(dashboardId, role)
      setFreshLink(inviteUrl(invite.code))
      setCopied(false)
      // The response IS the invite row — prepend it (the list is newest-first) instead of
      // refetching a list we can construct locally.
      setInvites((current) => [
        {
          id: invite.id,
          role: invite.role,
          expires_at: invite.expires_at,
          created_at: invite.created_at,
        },
        ...current,
      ])
    } catch {
      toast.error('Failed to create an invite link.')
    } finally {
      setCreating(false)
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; the link is selectable on screen either way.
      toast.info('Copy the link manually — clipboard access was blocked.')
    }
  }

  async function handleRevoke(invite: DashboardInvite) {
    setBusyId(invite.id)
    try {
      await apiRevokeInvite(dashboardId, invite.id)
      setInvites((current) => current.filter((row) => row.id !== invite.id))
    } catch {
      toast.error('Failed to revoke the invite link.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="text-sm text-zinc-400">Invite someone</span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as ShareRole)}
            aria-label="Role"
            className="h-9 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
          >
            {roleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-50"
          >
            <Link2 size={14} />
            {creating ? 'Creating…' : 'Create invite link'}
          </button>
        </div>
        {selectedRoleOption?.description && (
          <p className="text-xs text-zinc-500">{selectedRoleOption.description}</p>
        )}
      </div>

      {freshLink && (
        <div className="rounded-md border border-zinc-700 bg-zinc-900 p-3 space-y-2">
          <p className="text-xs text-zinc-400">
            Send this link to the person you want to invite. It works once, and you won't be able to
            see it again after closing this.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={freshLink}
              aria-label="Invite link"
              onFocus={(event) => event.currentTarget.select()}
              className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs text-zinc-300"
            />
            <button
              type="button"
              onClick={() => void handleCopy(freshLink)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-zinc-100 px-2.5 text-xs font-medium text-zinc-950 hover:bg-white transition-colors"
            >
              <Copy size={12} />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => setFreshLink(null)}
              className="flex h-8 shrink-0 items-center rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {!loading && invites.length > 0 && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900 overflow-hidden">
          <p className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
            Unused invite links
          </p>
          <ul className="divide-y divide-zinc-800">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">
                    {roleOptions.find((option) => option.value === invite.role)?.label ??
                      invite.role}
                  </p>
                  <p className="text-xs text-zinc-500 truncate">{expiryLabel(invite.expires_at)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevoke(invite)}
                  disabled={busyId === invite.id}
                  aria-label="Revoke invite link"
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
