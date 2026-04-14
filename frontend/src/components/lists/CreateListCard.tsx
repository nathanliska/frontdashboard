import { useState } from 'react'
import { X } from 'lucide-react'
import type { ListType } from '../../api/lists'

export function CreateListCard({
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    await onCreate(name, listType)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 space-y-2 shrink-0"
    >
      <input
        autoFocus
        placeholder="List name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
      />
      <select
        value={listType}
        onChange={(event) => setListType(event.target.value as ListType)}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
      >
        <option value="checklist">Checklist</option>
        <option value="grocery">Grocery</option>
        <option value="todo">Todo</option>
      </select>
      <p className="text-xs text-zinc-500">
        This list will belong to {activeDashboardName ?? 'the selected dashboard'}.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          className="flex-1 bg-zinc-100 text-zinc-900 rounded-md py-1.5 text-xs font-medium hover:bg-zinc-200 transition-colors"
        >
          Create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-2 text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </form>
  )
}
