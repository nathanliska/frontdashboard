import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { ListType } from '../../api/lists'

export function CreateListModal({
  activeDashboardName,
  onCreate,
  onClose,
}: {
  activeDashboardName?: string
  onCreate: (name: string, listType: ListType) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [listType, setListType] = useState<ListType>('checklist')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || submitting) return

    setSubmitting(true)
    try {
      await onCreate(name, listType)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close create list dialog"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-list-title"
        className="relative mx-4 w-full max-w-sm overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <div className="border-b border-zinc-800 px-5 py-4">
          <h2 id="create-list-title" className="text-sm font-semibold text-zinc-100">
            Create list
          </h2>
        </div>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400" htmlFor="create-list-name">
                Name
              </label>
              <input
                ref={inputRef}
                id="create-list-name"
                required
                placeholder="List name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-400" htmlFor="create-list-type">
                Type
              </label>
              <select
                id="create-list-type"
                value={listType}
                onChange={(event) => setListType(event.target.value as ListType)}
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
              >
                <option value="checklist">Checklist</option>
                <option value="grocery">Grocery</option>
                <option value="todo">Todo</option>
              </select>
            </div>

            <p className="text-xs text-zinc-500">
              This list will belong to {activeDashboardName ?? 'the selected dashboard'}.
            </p>
          </div>

          <div className="flex gap-2 border-t border-zinc-800 p-5 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md bg-zinc-800 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-md bg-zinc-100 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
