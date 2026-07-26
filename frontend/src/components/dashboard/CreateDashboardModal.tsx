import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { DashboardSummary } from '../../api/dashboards'
import { Dialog } from '../ui/Dialog'

export function CreateDashboardModal({
  onCreated,
  onClose,
  createDashboard,
}: {
  onCreated: (summary: DashboardSummary) => void
  onClose: () => void
  createDashboard: (data: { name: string }) => Promise<DashboardSummary | null>
}) {
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('dashboard-name') ?? '').trim()
    if (!name) return

    setSubmitting(true)
    try {
      const summary = await createDashboard({ name })
      // Keep the modal open on failure (the store already toasted). No throw to leak.
      if (summary) onCreated(summary)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog title="Create dashboard" onClose={onClose}>
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
              ref={nameInputRef}
              id="create-dashboard-name"
              name="dashboard-name"
              required
              placeholder="My Dashboard"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <p className="text-xs text-zinc-500">
            This dashboard starts private to you. Once it exists, open its settings to create an
            invite link for anyone you want to share it with.
          </p>
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
    </Dialog>
  )
}
