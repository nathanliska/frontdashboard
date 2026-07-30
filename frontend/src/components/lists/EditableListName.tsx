import { Check, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../utils/shared/cn'

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
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setDraft(name)
    setError(null)
    setEditing(true)
  }

  function cancelEditing() {
    setDraft(name)
    setError(null)
    setEditing(false)
  }

  async function submitEdit() {
    // Validated here rather than by the caller, so the message can be attached to this input
    // instead of floating away in a toast.
    if (!draft.trim()) {
      setError('List name cannot be empty.')
      inputRef.current?.focus()
      return
    }
    setError(null)
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
          name="list-name"
          value={draft}
          aria-label="List name"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'list-name-error' : undefined}
          onChange={(event) => {
            setDraft(event.target.value)
            if (error) setError(null)
          }}
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
          className={cn(
            'min-w-0 flex-1 bg-zinc-800 border rounded px-2 py-1 text-sm font-medium text-zinc-100 focus:outline-none',
            error
              ? 'border-red-500/60 focus:border-red-500'
              : 'border-zinc-700 focus:border-zinc-500',
          )}
        />
        <p
          id="list-name-error"
          role="alert"
          className="order-last basis-full sm:order-0 sm:basis-auto text-xs text-red-400"
          hidden={!error}
        >
          {error}
        </p>
        {!error && (
          <p className="order-last basis-full sm:order-0 sm:basis-auto text-xs text-zinc-500">
            Managed by {activeDashboardName ?? 'this dashboard'}.
          </p>
        )}
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
