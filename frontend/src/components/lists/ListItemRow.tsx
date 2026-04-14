import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import type { ListItem } from '../../api/lists'
import { cn } from '../../utils/shared/cn'

export function ListItemRow({
  item,
  onToggleChecked,
  onRename,
  onDelete,
}: {
  item: ListItem
  onToggleChecked: (itemId: string, checked: boolean) => Promise<void>
  onRename: (itemId: string, text: string) => Promise<void>
  onDelete: (itemId: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setConfirmingDelete(false)
    setDraft(item.text)
    setEditing(true)
  }

  function cancelEditing() {
    setDraft(item.text)
    setEditing(false)
  }

  async function submitEdit() {
    try {
      await onRename(item.id, draft)
      setEditing(false)
    } catch {
      // keep the editor open so the user can retry
    }
  }

  return (
    <li className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b border-zinc-800 group last:border-0">
      <button
        onClick={() => void onToggleChecked(item.id, !item.checked)}
        className={cn(
          'shrink-0 w-4 h-4 rounded border transition-colors flex items-center justify-center',
          item.checked ? 'bg-zinc-600 border-zinc-600' : 'border-zinc-600 hover:border-zinc-400',
        )}
        aria-label={item.checked ? 'Uncheck' : 'Check'}
      >
        {item.checked && (
          <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-zinc-200">
            <path
              d="M2 6l2.5 2.5L10 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void submitEdit()}
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
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
      ) : (
        <button
          type="button"
          onClick={() => void onToggleChecked(item.id, !item.checked)}
          className={cn(
            'flex-1 min-w-0 text-left text-sm transition-colors',
            item.checked
              ? 'line-through text-zinc-600 hover:text-zinc-500'
              : 'text-zinc-300 hover:text-zinc-100',
          )}
          title={item.checked ? 'Uncheck item' : 'Check item'}
        >
          <span className="block truncate">{item.text}</span>
        </button>
      )}
      {confirmingDelete ? (
        <>
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false)
              void onDelete(item.id)
            }}
            className="opacity-100 transition-opacity p-0.5 text-zinc-600 hover:text-red-400"
            aria-label="Confirm delete item"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(false)}
            className="opacity-100 transition-opacity p-0.5 text-zinc-600 hover:text-zinc-300"
            aria-label="Cancel delete item"
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={startEditing}
            className="p-0.5 text-zinc-600 hover:text-zinc-300 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
            aria-label="Edit item"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="p-0.5 text-zinc-600 hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
            aria-label="Delete item"
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </li>
  )
}
