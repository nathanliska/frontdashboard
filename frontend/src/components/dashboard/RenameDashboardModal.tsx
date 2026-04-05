import { useEffect, useMemo, useState } from 'react'
import { Search, Trash2, Users } from 'lucide-react'
import {
  apiAddDashboardShare,
  apiGetDashboard,
  apiGetDashboardShares,
  apiRemoveDashboardShare,
  apiUpdateDashboardShare,
  type DashboardSummary,
} from '../../api/dashboards'
import type { PrincipalType, ResourceShare, ShareRole } from '../../api/shares'
import { apiSearchUsers, type SearchUserResult } from '../../api/users'
import { toast } from '../../stores/toast'
import { cn } from '../../utils/cn'

type Candidate = {
  id: string
  label: string
  meta: string
  principal_type: PrincipalType
}

const DASHBOARD_ROLE_OPTIONS = [
  {
    value: 'viewer' as const,
    label: 'View',
    description: 'Can open this dashboard and see the widgets and content.',
  },
  {
    value: 'editor' as const,
    label: 'Edit',
    description: 'Can change layout and add or remove widgets.',
  },
]

export function RenameDashboardModal({
  dashboard,
  onClose,
  onRename,
}: {
  dashboard: Pick<DashboardSummary, 'id' | 'name'>
  onClose: () => void
  onRename: (id: string, name: string) => Promise<void>
}) {
  const [name, setName] = useState(dashboard.name)
  const [submitting, setSubmitting] = useState(false)
  const [shares, setShares] = useState<ResourceShare[]>([])
  const [sharesLoading, setSharesLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [userResults, setUserResults] = useState<SearchUserResult[]>([])
  const [searching, setSearching] = useState(false)
  const [newShareRole, setNewShareRole] = useState<ShareRole>('viewer')
  const [busyShareId, setBusyShareId] = useState<string | null>(null)
  const [addingPrincipalId, setAddingPrincipalId] = useState<string | null>(null)
  const [managedResourceCount, setManagedResourceCount] = useState(0)
  const selectedRoleOption = DASHBOARD_ROLE_OPTIONS.find((option) => option.value === newShareRole)

  useEffect(() => {
    setName(dashboard.name)
  }, [dashboard.id, dashboard.name])

  useEffect(() => {
    let cancelled = false
    setSharesLoading(true)

    void Promise.all([apiGetDashboardShares(dashboard.id), apiGetDashboard(dashboard.id)])
      .then(([loadedShares, loadedDashboard]) => {
        if (cancelled) return
        setShares(loadedShares)
        setManagedResourceCount(
          new Set(
            loadedDashboard.widgets
              .filter((widget) => widget.resource_type && widget.resource_id)
              .map((widget) => `${widget.resource_type}:${widget.resource_id}`),
          ).size,
        )
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
  }, [dashboard.id])

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

  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    const trimmed = name.trim()
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

  async function handleRoleChange(share: ResourceShare, role: ShareRole) {
    if (share.role === role) return
    setBusyShareId(share.id)
    try {
      const updated = await apiUpdateDashboardShare(dashboard.id, share.id, { role })
      setShares((current) => current.map((item) => (item.id === share.id ? updated : item)))
    } catch {
      toast.error('Failed to update permission.')
    } finally {
      setBusyShareId(null)
    }
  }

  async function handleRemoveShare(share: ResourceShare) {
    setBusyShareId(share.id)
    try {
      await apiRemoveDashboardShare(dashboard.id, share.id)
      setShares((current) => current.filter((item) => item.id !== share.id))
    } catch {
      toast.error('Failed to remove permission.')
    } finally {
      setBusyShareId(null)
    }
  }

  async function handleAddCandidate(candidate: Candidate) {
    const existing = shares.find(
      (share) =>
        share.principal_type === candidate.principal_type && share.principal_id === candidate.id,
    )
    if (existing) {
      toast.error('That permission already exists.')
      return
    }

    setAddingPrincipalId(candidate.id)
    try {
      const created = await apiAddDashboardShare(dashboard.id, {
        principal_type: candidate.principal_type,
        principal_id: candidate.id,
        role: newShareRole,
      })
      setShares((current) => [...current, created])
      setQuery('')
      setUserResults([])
    } catch {
      toast.error('Failed to add permission.')
    } finally {
      setAddingPrincipalId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">Edit dashboard</h2>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col max-h-[calc(85vh-57px)]"
        >
          <div className="p-5 space-y-5 overflow-y-auto">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400">Name</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dashboard name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Users size={14} className="text-zinc-500" />
                <div>
                  <h3 className="text-sm font-medium text-zinc-200">Permissions</h3>
                  <p className="text-xs text-zinc-500">
                    Choose who should be able to view or edit this dashboard.
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 space-y-3">
                {managedResourceCount > 0 && (
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                    <p className="text-xs text-zinc-400">
                      This dashboard currently manages access to {managedResourceCount}{' '}
                      {managedResourceCount === 1 ? 'bound item' : 'bound items'}.
                    </p>
                  </div>
                )}
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
                        placeholder="Search people"
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
                      {DASHBOARD_ROLE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {selectedRoleOption?.description && (
                      <span className="text-xs text-zinc-500">
                        {selectedRoleOption.description}
                      </span>
                    )}
                  </label>
                </div>

                {managedResourceCount > 0 && (
                  <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2">
                    <p className="text-xs text-blue-200/90">
                      Anyone you add here will also get access to {managedResourceCount}{' '}
                      dashboard-managed {managedResourceCount === 1 ? 'item' : 'items'}.
                    </p>
                  </div>
                )}

                {query.trim() ? (
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 overflow-hidden">
                    {searching ? (
                      <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div>
                    ) : candidates.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-zinc-500">No matches found.</div>
                    ) : (
                      <ul className="divide-y divide-zinc-800">
                        {candidates.map((candidate) => (
                          <li
                            key={`${candidate.principal_type}:${candidate.id}`}
                            className="flex items-center justify-between gap-3 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-zinc-200 truncate">{candidate.label}</p>
                              <p className="text-xs text-zinc-500 truncate">{candidate.meta}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleAddCandidate(candidate)}
                              disabled={addingPrincipalId === candidate.id}
                              className="shrink-0 rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-50"
                            >
                              Add
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-600">Type at least 2 characters to search.</p>
                )}

                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">Current access</p>
                  {sharesLoading ? (
                    <div className="text-xs text-zinc-500">Loading permissions…</div>
                  ) : shares.length === 0 ? (
                    <div className="text-xs text-zinc-600">
                      Only you can access this dashboard right now.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {shares.map((share) => (
                        <li
                          key={share.id}
                          className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-zinc-200 truncate">{share.principal_name}</p>
                            <p className="text-xs text-zinc-500">
                              {share.principal_type === 'user' ? 'Person' : 'Legacy group access'}
                            </p>
                          </div>
                          <select
                            value={share.role}
                            onChange={(e) =>
                              void handleRoleChange(share, e.target.value as ShareRole)
                            }
                            disabled={busyShareId === share.id}
                            className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-700 disabled:opacity-50"
                          >
                            {DASHBOARD_ROLE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => void handleRemoveShare(share)}
                            disabled={busyShareId === share.id}
                            className="rounded-md p-2 text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
                            aria-label={`Remove ${share.principal_name}`}
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
              disabled={submitting || !name.trim()}
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
