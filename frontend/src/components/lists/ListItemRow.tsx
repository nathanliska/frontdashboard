import { CalendarPlus, Check, GripVertical, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ListItem } from '../../api/lists'
import { dateKey, formatCalendarDay, startOfDay } from '../../utils/calendar/calendarUtils'
import { cn } from '../../utils/shared/cn'
import type { SortableRow } from './SortableList'

export function ListItemRow({
  item,
  onToggleChecked,
  onRename,
  onSetDueDate,
  onDelete,
  sortable,
  indentForHandle = false,
}: {
  item: ListItem
  onToggleChecked: (itemId: string, checked: boolean) => Promise<void>
  onRename: (itemId: string, text: string) => Promise<void>
  onSetDueDate: (itemId: string, dueDate: string | null) => Promise<void>
  onDelete: (itemId: string) => Promise<void>
  sortable?: SortableRow
  /** Reserve the drag handle's footprint so this row's text aligns with sortable siblings. */
  indentForHandle?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Deliberately its own control rather than a field inside the text editor: the text input
  // submits on blur, so clicking a date picker nested in it would save and close the editor
  // before the date could be chosen.
  const [pickingDate, setPickingDate] = useState(false)
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

  async function commitDueDate(value: string) {
    try {
      await onSetDueDate(item.id, value || null)
      setPickingDate(false)
    } catch {
      // keep the picker open so the user can retry
    }
  }

  return (
    <li
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      data-item-id={item.id}
      className={cn(
        'flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b border-zinc-800 group last:border-0',
        sortable?.isDragging && 'opacity-60',
      )}
    >
      {sortable ? (
        <button
          type="button"
          {...sortable.attributes}
          {...sortable.listeners}
          aria-label="Reorder item"
          className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 cursor-grab touch-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
        >
          <GripVertical size={14} />
        </button>
      ) : (
        indentForHandle && (
          // Same padded wrapper as the handle button, so the footprint matches to the pixel.
          <span aria-hidden="true" className="shrink-0 p-0.5">
            <span className="block w-3.5 h-3.5" />
          </span>
        )
      )}
      <button
        type="button"
        onClick={() => void onToggleChecked(item.id, !item.checked)}
        className={cn(
          'shrink-0 w-4 h-4 rounded border transition-colors flex items-center justify-center',
          item.checked ? 'bg-zinc-600 border-zinc-600' : 'border-zinc-600 hover:border-zinc-400',
        )}
        aria-label={item.checked ? 'Uncheck' : 'Check'}
      >
        {item.checked && (
          <svg aria-hidden="true" viewBox="0 0 12 12" className="w-2.5 h-2.5 text-zinc-200">
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
          name="item-text"
          aria-label="Item text"
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
      {pickingDate ? (
        <input
          // The input replaces a button the user just activated, so focus has to follow it —
          // without this the keyboard path opens a picker it cannot then reach.
          // biome-ignore lint/a11y/noAutofocus: replaces the button that was just activated
          autoFocus
          type="date"
          defaultValue={item.due_date ?? ''}
          onChange={(event) => void commitDueDate(event.target.value)}
          onBlur={() => setPickingDate(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setPickingDate(false)
            }
          }}
          aria-label="Due date"
          className="shrink-0 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500"
        />
      ) : item.due_date ? (
        <button
          type="button"
          onClick={() => setPickingDate(true)}
          aria-label={`Due ${item.due_date}. Change due date`}
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums transition-colors',
            // Overdue only matters while the item is outstanding — a checked item is done, and
            // colouring it red says it still needs attention.
            !item.checked && item.due_date < dateKey(startOfDay(new Date()))
              ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
              : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200',
          )}
        >
          {formatCalendarDay(item.due_date)}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setPickingDate(true)}
          aria-label="Set due date"
          className="shrink-0 p-0.5 text-zinc-600 hover:text-zinc-300 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
        >
          <CalendarPlus size={14} />
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
            className="p-0.5 text-zinc-600 hover:text-zinc-300 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
            aria-label="Edit item"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="p-0.5 text-zinc-600 hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity"
            aria-label="Delete item"
          >
            <Trash2 size={14} />
          </button>
        </>
      )}
    </li>
  )
}
