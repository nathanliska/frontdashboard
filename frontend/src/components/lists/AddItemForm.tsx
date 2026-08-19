import { Plus, Undo2 } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import type { ListItem } from '../../api/lists'
import { cn } from '../../utils/shared/cn'
import { matchesItemText } from './checkedPile'

const MAX_SUGGESTIONS = 5
// The popup grows upward inside a widget card that clips, so the exact match — ranked first, and
// therefore furthest from the input — is what a short card would cut off. Fewer rows, less reach.
const MAX_SUGGESTIONS_COMPACT = 3

/** Case-insensitive substring match over checked items, exact match ranked first. */
function matchChecked(checkedItems: Pick<ListItem, 'id' | 'text'>[], query: string, limit: number) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  // Same normalization as matchesItemText, so an exact match always ranks and displays.
  const matches = checkedItems.filter((item) => item.text.trim().toLowerCase().includes(needle))
  matches.sort((a, b) => {
    const aExact = matchesItemText(a.text, query) ? 0 : 1
    const bExact = matchesItemText(b.text, query) ? 0 : 1
    return aExact - bExact
  })
  return matches.slice(0, limit)
}

export function AddItemForm({
  onAdd,
  checkedItems = [],
  onRestore,
  compact = false,
}: {
  onAdd: (text: string) => Promise<void>
  checkedItems?: Pick<ListItem, 'id' | 'text'>[]
  onRestore?: (itemId: string) => Promise<void>
  /** Widget sizing: tighter rows, no prefix icon, and a persistent icon submit. */
  compact?: boolean
}) {
  const [text, setText] = useState('')
  // Highlight is tracked by item id, not index: the pile can reshuffle underneath (a remote
  // check arriving over SSE), and Enter must restore the row the user saw highlighted.
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const suggestions = useMemo(
    () =>
      onRestore && !dismissed
        ? matchChecked(checkedItems, text, compact ? MAX_SUGGESTIONS_COMPACT : MAX_SUGGESTIONS)
        : [],
    [onRestore, dismissed, checkedItems, text, compact],
  )
  const activeIndex = activeId ? suggestions.findIndex((s) => s.id === activeId) : -1
  const optionId = (itemId: string) => `${listboxId}-${itemId}`

  // Combobox semantics only where a popup can actually exist, and each IDREF only while its
  // target exists — a permanent collapsed combobox with a dangling aria-controls is an axe
  // failure, and so is pointing at a suggestion the pile has since dropped. activedescendant
  // is what names the highlight: focus stays in the input, so aria-selected alone announces
  // nothing as the user arrows through.
  const comboboxProps = onRestore
    ? {
        role: 'combobox' as const,
        'aria-expanded': suggestions.length > 0,
        'aria-controls': suggestions.length > 0 ? listboxId : undefined,
        'aria-activedescendant':
          activeIndex >= 0 ? optionId(suggestions[activeIndex].id) : undefined,
        'aria-autocomplete': 'list' as const,
      }
    : {}

  async function restore(itemId: string) {
    if (!onRestore) return
    const previousText = text
    setText('')
    setActiveId(null)
    try {
      await onRestore(itemId)
      inputRef.current?.focus()
    } catch {
      setText(previousText)
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedText = text.trim()
    if (!trimmedText) return

    // Enter on a highlighted suggestion — or on text exactly matching a checked item —
    // unchecks that item instead of minting a duplicate row. The exact match runs over the
    // FULL pile, not the displayed slice: a data rule must not depend on presentation caps.
    // Gated on onRestore, not just on the text: without a way to restore, a match would make
    // the form a dead end that neither adds nor unchecks.
    const highlighted = activeIndex >= 0 ? suggestions[activeIndex] : undefined
    const exact =
      onRestore && !dismissed
        ? checkedItems.find((item) => matchesItemText(item.text, trimmedText))
        : undefined
    const target = highlighted ?? exact
    if (target) {
      await restore(target.id)
      return
    }

    const previousText = text
    setText('')
    try {
      await onAdd(trimmedText)
      inputRef.current?.focus()
    } catch {
      setText(previousText)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveId(suggestions[(activeIndex + 1) % suggestions.length].id)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveId(suggestions[activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1].id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
      setActiveId(null)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'relative border-t border-zinc-800 shrink-0',
        compact ? 'pt-2' : 'px-3 sm:px-4 py-2.5',
      )}
    >
      {suggestions.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Checked items matching your text"
          className={cn(
            'absolute bottom-full mb-1 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg overflow-hidden',
            compact ? 'left-0 right-0' : 'left-2 right-2',
          )}
        >
          {suggestions.map((item) => (
            <button
              key={item.id}
              id={optionId(item.id)}
              type="button"
              role="option"
              aria-selected={item.id === activeId}
              // Fires before the input's blur so the click cannot lose the race with a re-render.
              onMouseDown={(event) => {
                event.preventDefault()
                void restore(item.id)
              }}
              className={cn(
                'w-full flex items-center gap-2 text-left transition-colors',
                compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm',
                item.id === activeId
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
              )}
            >
              <Undo2 size={compact ? 11 : 13} className="shrink-0 text-zinc-500" />
              <span className="truncate line-through">{item.text}</span>
              <span className="ml-auto shrink-0 text-[10px] text-zinc-600">re-add</span>
            </button>
          ))}
        </div>
      )}
      <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
        {!compact && <Plus size={14} className="text-zinc-600 shrink-0" />}
        {/* text-base keeps mobile at 16px; below that iOS (any browser — all WebKit) zooms on focus */}
        {/* aria-label, not placeholder alone: a placeholder is not a reliable accessible name and
            disappears once typing starts. `name` also stops the browser flagging an unnamed field. */}
        <input
          ref={inputRef}
          name="new-item"
          aria-label="Add item"
          {...comboboxProps}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setActiveId(null)
            setDismissed(false)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Add item…"
          className={cn(
            'flex-1 bg-transparent text-base focus:outline-none',
            compact
              ? 'sm:text-xs text-zinc-400 placeholder-zinc-700 min-w-0'
              : 'sm:text-sm text-zinc-300 placeholder-zinc-600',
          )}
        />
        {/* Persistent in a widget: the icon is the only add affordance there, and one that appears
            on keystroke reads as a layout shift in a cell that small. */}
        {compact ? (
          <button
            type="submit"
            aria-label="Add"
            className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <Plus size={12} />
          </button>
        ) : (
          text.trim() && (
            <button
              type="submit"
              className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              Add
            </button>
          )
        )}
      </div>
    </form>
  )
}
