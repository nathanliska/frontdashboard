import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ShareRole } from '../../../api/shares'
import { useShareSearch } from '../../../hooks/useShareSearch'
import type {
  SharePanelAddPayload,
  SharePanelItem,
  ShareRoleOption,
  ShareSearchCandidate,
} from '../../../utils/share/sharePanelTypes'

export function SharePanelAddAccess({
  items,
  onAdd,
  roleOptions,
  searchPlaceholder,
  searchHint,
}: {
  items: SharePanelItem[]
  onAdd: (share: SharePanelAddPayload) => void | Promise<void>
  roleOptions: ShareRoleOption[]
  searchPlaceholder: string
  searchHint: string
}) {
  const [query, setQuery] = useState('')
  const [newShareRole, setNewShareRole] = useState<ShareRole>('viewer')
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const duplicateKeys = useMemo(() => new Set(items.map((item) => item.key)), [items])
  const selectedRoleOption = roleOptions.find((option) => option.value === newShareRole)
  const { candidates, searching } = useShareSearch(query)
  const candidateEntries = useMemo(
    () =>
      candidates.map((candidate) => {
        const key = `${candidate.principal_type}:${candidate.id}`
        return {
          ...candidate,
          key,
          duplicate: duplicateKeys.has(key),
        }
      }),
    [candidates, duplicateKeys],
  )
  const statusMessage =
    trimmedQuery.length < 2
      ? searchHint
      : searching
        ? 'Searching for people.'
        : candidateEntries.length === 0
          ? 'No matches found.'
          : `${candidateEntries.length} ${candidateEntries.length === 1 ? 'match' : 'matches'} found.`

  async function handleAdd(candidate: ShareSearchCandidate) {
    const key = `${candidate.principal_type}:${candidate.id}`
    if (duplicateKeys.has(key)) return

    setAddingKey(key)
    try {
      await onAdd({
        principal_type: candidate.principal_type,
        principal_id: candidate.id,
        principal_name: candidate.label,
        role: newShareRole,
      })
      setQuery('')
    } finally {
      setAddingKey(null)
    }
  }

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </p>

      <div className="grid gap-3 md:grid-cols-[1fr_160px]">
        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">Add access</span>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-9 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
            />
          </div>
        </label>

        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">Role</span>
          <select
            value={newShareRole}
            onChange={(event) => setNewShareRole(event.target.value as ShareRole)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-zinc-700"
          >
            {roleOptions.map((option) => (
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

      {trimmedQuery.length >= 2 ? (
        <div
          className="rounded-md border border-zinc-800 bg-zinc-900 overflow-hidden"
          aria-busy={searching}
        >
          {searching ? (
            <div className="px-3 py-2 text-xs text-zinc-500">Searching…</div>
          ) : candidateEntries.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">No matches found.</div>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {candidateEntries.map((candidate) => (
                <li
                  key={candidate.key}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{candidate.label}</p>
                    <p className="text-xs text-zinc-500 truncate">{candidate.meta}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleAdd(candidate)}
                    disabled={candidate.duplicate || addingKey === candidate.key}
                    className="shrink-0 rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-50"
                  >
                    {candidate.duplicate ? 'Added' : 'Add'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-zinc-600">{searchHint}</p>
      )}
    </>
  )
}
