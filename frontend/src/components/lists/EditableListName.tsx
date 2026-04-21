import { Check, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function EditableListName({
  name,
  activeDashboardName,
  onRename,
}: {
  name: string
  activeDashboardName?: string
  onRename: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(name)
    setEditing(true)
  }

  function cancelEditing() {
    setDraft(name)
    setEditing(false)
  }

  async function submitEdit() {
    try {
      await onRename(draft)
      setEditing(false)
    } catch {
      // keep the editor open so the user can retry
    }
  }

  if (editing) {
    return (
      <>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitEdit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelEditing()
            }
          }}
          className="min-w-0 flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-medium text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
        <p className="order-last basis-full sm:order-0 sm:basis-auto text-xs text-zinc-500">
          Managed by {activeDashboardName ?? 'this dashboard'}.
        </p>
        <button
          type="button"
          onClick={() => void submitEdit()}
          className="p-0.5 text-zinc-500 hover:text-zinc-100"
          aria-label="Save list name"
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          onClick={cancelEditing}
          className="p-0.5 text-zinc-500 hover:text-zinc-300"
          aria-label="Cancel editing list name"
        >
          <X size={14} />
        </button>
      </>
    )
  }

  return (
    <>
      <span className="min-w-0 flex-1 text-sm sm:text-base font-medium text-zinc-100 truncate">
        {name}
      </span>
      <button
        type="button"
        onClick={startEditing}
        className="p-0.5 text-zinc-500 hover:text-zinc-300"
        aria-label="Edit list name"
      >
        <Pencil size={14} />
      </button>
    </>
  )
}
