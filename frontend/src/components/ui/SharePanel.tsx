import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Search, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { InheritedDashboardAccess, PrincipalType, ShareRole } from '../../api/shares'
import { apiSearchUsers, type SearchUserResult } from '../../api/users'

export interface SharePanelItem {
  key: string
  principal_type: PrincipalType
  principal_id: string
  principal_name: string
  role: ShareRole
}

type Candidate = {
  id: string
  label: string
  meta: string
  principal_type: PrincipalType
}

const SHARE_ROLES: ShareRole[] = ['viewer', 'editor']

export interface ShareRoleOption {
  value: ShareRole
  label: string
  description?: string
}

export function SharePanel({
  items,
  onAdd,
  onUpdate,
  onRemove,
  title = 'Permissions',
  description = 'Share this resource with people.',
  emptyMessage = 'Only you can access this right now.',
  roleOptions,
  currentAccessLabel = 'Current access',
  searchPlaceholder = 'Search people',
  searchHint = 'Type at least 2 characters to search.',
}: {
  items: SharePanelItem[]
  onAdd: (share: {
    principal_type: PrincipalType
    principal_id: string
    principal_name: string
    role: ShareRole
  }) => void | Promise<void>
  onUpdate: (item: SharePanelItem, role: ShareRole) => void | Promise<void>
  onRemove: (item: SharePanelItem) => void | Promise<void>
  title?: string
  description?: string
  emptyMessage?: string
  roleOptions?: ShareRoleOption[]
  currentAccessLabel?: string
  searchPlaceholder?: string
  searchHint?: string
}) {
  const [query, setQuery] = useState('')
  const [userResults, setUserResults] = useState<SearchUserResult[]>([])
  const [searching, setSearching] = useState(false)
  const [newShareRole, setNewShareRole] = useState<ShareRole>('viewer')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const effectiveRoleOptions: ShareRoleOption[] =
    roleOptions ??
    SHARE_ROLES.map((role) => ({
      value: role,
      label: formatRole(role),
    }))
  const selectedRoleOption = effectiveRoleOptions.find((option) => option.value === newShareRole)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setUserResults([])
      setSearching(false)
      return
    }

    let cancelled = false
    setSearching(true)
    const timeout = window.setTimeout(() => {
      void apiSearchUsers(trimmed)
        .then((results) => {
          if (!cancelled) setUserResults(results)
        })
        .catch(() => {
          if (!cancelled) setUserResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [query])

  const candidates = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return [] as Candidate[]

    const userMatches = userResults.map((user) => ({
      id: user.id,
      label: user.display_name,
      meta: user.email,
      principal_type: 'user' as const,
    }))

    return userMatches
  }, [query, userResults])

  async function handleAdd(candidate: Candidate) {
    const key = `${candidate.principal_type}:${candidate.id}`
    if (items.some((item) => item.key === key)) return

    setAddingKey(key)
    try {
      await onAdd({
        principal_type: candidate.principal_type,
        principal_id: candidate.id,
        principal_name: candidate.label,
        role: newShareRole,
      })
      setQuery('')
      setUserResults([])
    } finally {
      setAddingKey(null)
    }
  }

  async function handleUpdate(item: SharePanelItem, role: ShareRole) {
    if (item.role === role) return
    setBusyKey(item.key)
    try {
      await onUpdate(item, role)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleRemove(item: SharePanelItem) {
    setBusyKey(item.key)
    try {
      await onRemove(item)
    } finally {
      setBusyKey(null)
    }
  }

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
        <div className="grid gap-3 md:grid-cols-[1fr_160px]">
          <label className="grid gap-1.5 text-sm">
            <span className="text-zinc-400">Add access</span>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-9 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
              />
            </div>
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="text-zinc-400">Role</span>
            <select
              value={newShareRole}
              onChange={(e) => setNewShareRole(e.target.value as ShareRole)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
            >
              {effectiveRoleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {selectedRoleOption?.description && (
              <span className="text-xs text-zinc-500">{selectedRoleOption.description}</span>
            )}
          </label>
        </div>

        {query.trim() ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-900 overflow-hidden">
            {searching ? (
              <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div>
            ) : candidates.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">No matches found.</div>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {candidates.map((candidate) => {
                  const candidateKey = `${candidate.principal_type}:${candidate.id}`
                  const duplicate = items.some((item) => item.key === candidateKey)
                  return (
                    <li
                      key={candidateKey}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-200 truncate">{candidate.label}</p>
                        <p className="text-xs text-zinc-500 truncate">{candidate.meta}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleAdd(candidate)}
                        disabled={duplicate || addingKey === candidateKey}
                        className="shrink-0 rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-50"
                      >
                        {duplicate ? 'Added' : 'Add'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-600">{searchHint}</p>
        )}

        <div className="space-y-2">
          <p className="text-xs text-zinc-400">{currentAccessLabel}</p>
          {items.length === 0 ? (
            <div className="text-xs text-zinc-600">{emptyMessage}</div>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200 truncate">{item.principal_name}</p>
                    <p className="text-xs text-zinc-500">Person</p>
                  </div>
                  <select
                    value={item.role}
                    onChange={(e) => void handleUpdate(item, e.target.value as ShareRole)}
                    disabled={busyKey === item.key}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700 disabled:opacity-50"
                  >
                    {effectiveRoleOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleRemove(item)}
                    disabled={busyKey === item.key}
                    className="rounded-md p-2 text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
                    aria-label={`Remove ${item.principal_name}`}
                    title="Remove access"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

export function DashboardManagedAccessList({
  dashboards,
  resourceLabel = 'resource',
}: {
  dashboards: InheritedDashboardAccess[]
  resourceLabel?: string
}) {
  if (dashboards.length === 0) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Users size={14} className="text-zinc-500" />
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Managed by dashboards</h3>
          <p className="text-xs text-zinc-500">
            Anyone who can access these dashboards can also access this {resourceLabel}. Change the
            dashboard audience there, or remove the widget from that dashboard.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <ul className="space-y-2">
          {dashboards.map((dashboard) => (
            <li
              key={dashboard.dashboard_id}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{dashboard.dashboard_name}</p>
                  <p className="mt-1 text-xs text-zinc-500">Managed by dashboard</p>
                </div>
                <Link
                  to={`/dashboard/${dashboard.dashboard_id}`}
                  className="shrink-0 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Open
                  <ExternalLink size={12} />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function formatRole(role: ShareRole): string {
  return role[0].toUpperCase() + role.slice(1)
}
