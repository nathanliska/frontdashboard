import { type FormEvent, useMemo, useState } from 'react'
import type { DashboardSummary } from '../../api/dashboards'
import type { ShareCreate, ShareRole } from '../../api/shares'
import { SharePanel, type SharePanelItem, type ShareRoleOption } from '../ui/SharePanel'

type DraftShare = ShareCreate & { principal_name: string }

const DASHBOARD_ROLE_OPTIONS: ShareRoleOption[] = [
  {
    value: 'viewer',
    label: 'View',
    description: 'Can open this dashboard and see the widgets and content.',
  },
  {
    value: 'editor',
    label: 'Edit',
    description: 'Can change layout, add or remove widgets.',
  },
] as const

export function CreateDashboardModal({
  onCreated,
  onClose,
  createDashboard,
}: {
  onCreated: (summary: DashboardSummary) => void
  onClose: () => void
  createDashboard: (data: { name: string; shares?: ShareCreate[] }) => Promise<DashboardSummary>
}) {
  const [draftShares, setDraftShares] = useState<DraftShare[]>([])
  const [submitting, setSubmitting] = useState(false)

  const shareItems = useMemo<SharePanelItem[]>(
    () =>
      draftShares.map((share) => ({
        key: `${share.principal_type}:${share.principal_id}`,
        principal_type: share.principal_type,
        principal_id: share.principal_id,
        principal_name: share.principal_name,
        role: share.role,
      })),
    [draftShares],
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('dashboard-name') ?? '').trim()
    if (!name) return

    setSubmitting(true)
    try {
      const summary = await createDashboard({
        name,
        shares: draftShares.map((share) => ({
          principal_id: share.principal_id,
          principal_type: share.principal_type,
          role: share.role,
        })),
      })
      onCreated(summary)
    } finally {
      setSubmitting(false)
    }
  }

  function updateDraftRole(item: SharePanelItem, role: ShareRole) {
    setDraftShares((current) =>
      current.map((share) =>
        share.principal_type === item.principal_type && share.principal_id === item.principal_id
          ? { ...share, role }
          : share,
      ),
    )
  }

  function removeDraft(item: SharePanelItem) {
    setDraftShares((current) =>
      current.filter(
        (share) =>
          !(
            share.principal_type === item.principal_type && share.principal_id === item.principal_id
          ),
      ),
    )
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
          <h2 className="text-sm font-semibold text-zinc-100">Create dashboard</h2>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col max-h-[calc(85vh-57px)]"
        >
          <div className="p-5 space-y-5 overflow-y-auto">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400" htmlFor="create-dashboard-name">
                Name
              </label>
              <input
                id="create-dashboard-name"
                name="dashboard-name"
                autoFocus
                required
                placeholder="My Dashboard"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <SharePanel
              items={shareItems}
              title="Initial access"
              description="Choose who should be able to view, use widgets on, or edit this dashboard."
              emptyMessage="This dashboard will start private to you."
              roleOptions={DASHBOARD_ROLE_OPTIONS}
              onAdd={({ principal_id, principal_name, principal_type, role }) => {
                setDraftShares((current) => [
                  ...current,
                  { principal_id, principal_name, principal_type, role },
                ])
              }}
              onUpdate={async (item, role) => {
                updateDraftRole(item, role)
              }}
              onRemove={async (item) => {
                removeDraft(item)
              }}
            />
            {draftShares.length > 0 && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                <p className="text-xs text-zinc-500">
                  People you add here will be able to open this dashboard as soon as it is created.
                  Any shared widgets you place on it later will follow this dashboard audience.
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2 p-5 pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-md text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-2 rounded-md text-sm bg-zinc-100 hover:bg-white text-zinc-900 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
