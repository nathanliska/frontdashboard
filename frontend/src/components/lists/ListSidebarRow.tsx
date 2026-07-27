import { Check, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ListSummary } from '../../api/lists'
import { cn } from '../../utils/shared/cn'
import type { SortableRow } from './SortableList'
import { TypeBadge } from './TypeBadge'

export function ListSidebarRow({
  list,
  selectedId,
  onSelect,
  onRename,
  onDelete,
  sortable,
}: {
  list: Pick<ListSummary, 'id' | 'name' | 'list_type' | 'item_count'>
  selectedId: string | null
  onSelect: (id: string) => void
  onRename: (listId: string, name: string) => Promise<void>
  onDelete: (listId: string) => Promise<void>
  sortable?: SortableRow
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(list.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  function startEditing() {
    setConfirmingDelete(false)
    setDraft(list.name)
    setError(null)
    setEditing(true)
  }

  function cancelEditing() {
    setDraft(list.name)
    setError(null)
    setEditing(false)
  }

  async function submitEdit() {
    // Validated here so the message can be attached to this input rather than toasted (#27).
    if (!draft.trim()) {
      setError('List name cannot be empty.')
      inputRef.current?.focus()
      return
    }
    setError(null)
    try {
      await onRename(list.id, draft)
      setEditing(false)
    } catch {
      // keep the editor open so the user can retry
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: the row contains real action buttons, so the outer click target cannot itself be a button
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      role="button"
      tabIndex={editing ? -1 : 0}
      aria-disabled={editing}
      aria-label={`Open list ${list.name}`}
      onClick={() => {
        if (!editing) onSelect(list.id)
      }}
      onKeyDown={(event) => {
        if (editing) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(list.id)
        }
      }}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg border transition-colors group',
        selectedId === list.id
          ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
          : 'cursor-pointer bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700',
        sortable?.isDragging && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {sortable && (
          <button
            type="button"
            {...sortable.attributes}
            {...sortable.listeners}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              sortable.listeners?.onKeyDown?.(event)
              event.stopPropagation()
            }}
            aria-label="Reorder list"
            className="shrink-0 p-0.5 -ml-1 text-zinc-600 hover:text-zinc-300 cursor-grab touch-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
          >
            <GripVertical size={13} />
          </button>
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            aria-label={`Rename ${list.name}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${list.id}-name-error` : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              if (error) setError(null)
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                void submitEdit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
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
        ) : (
          <span className="text-sm font-medium truncate flex-1">{list.name}</span>
        )}
        <div className="flex items-center gap-1 shrink-0 text-zinc-500 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmingDelete(false)
                  void onDelete(list.id)
                }}
                title="Confirm move to trash"
                className="p-0.5 text-zinc-500 hover:text-red-400"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmingDelete(false)
                }}
                title="Cancel"
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <X size={13} />
              </button>
            </>
          ) : editing ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void submitEdit()
                }}
                title="Save list name"
                className="p-0.5 text-zinc-500 hover:text-zinc-100"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  cancelEditing()
                }}
                title="Cancel editing"
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  startEditing()
                }}
                title="Edit name"
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirmingDelete(true)
                }}
                title="Move to trash"
                className="p-0.5 text-zinc-500 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p id={`${list.id}-name-error`} role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 mt-1">
        <TypeBadge type={list.list_type} />
        <span className="text-xs text-zinc-600">
          {list.item_count} item{list.item_count !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}
