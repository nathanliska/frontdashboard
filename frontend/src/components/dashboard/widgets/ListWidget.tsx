import { Check, ChevronDown, ChevronRight, ListChecks } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ListWidgetConfig } from '../../../api/dashboards'
import { ApiError } from '../../../api/http'
import type { ListItem } from '../../../api/lists'
import { addListItem, updateListItem, useListDetail } from '../../../resources/listData'
import { useDashboardStore } from '../../../stores/dashboard'
import { dateKey, formatCalendarDay, startOfDay } from '../../../utils/calendar/calendarUtils'
import { cn } from '../../../utils/shared/cn'
import { scrollToNewestItem } from '../../../utils/shared/scrollToNewestItem'
import { AddItemForm } from '../../lists/AddItemForm'
import { partitionItems, setPileEnabled, usePileEnabled } from '../../lists/checkedPile'
import { WidgetErrorState } from '../WidgetErrorState'

export function ListWidget({
  listId,
  widgetId,
  config,
}: {
  listId: string
  widgetId: string
  config: ListWidgetConfig
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const updateWidget = useDashboardStore((s) => s.updateWidget)
  const { data: detail, error, refetch } = useListDetail(listId)

  const pileOn = usePileEnabled(listId)
  // A transient peek, deliberately not the page's persisted expand state: the tile's whole
  // point is showing only unchecked items, so it re-collapses on remount.
  const [pileOpen, setPileOpen] = useState(false)
  // Memoized: this component re-renders per ResizeObserver tick during a grid resize.
  const { active, pile } = useMemo(
    () => (detail ? partitionItems(detail.items) : { active: [], pile: [] }),
    [detail],
  )

  useEffect(() => {
    if (!detail) return

    if (config.list_name === detail.name && config.list_type === detail.list_type) return

    void updateWidget(widgetId, {
      ...config,
      list_name: detail.name,
      list_type: detail.list_type,
    })
  }, [config, detail, updateWidget, widgetId])

  async function handleToggle(item: ListItem) {
    if (!detail) return
    try {
      await updateListItem(listId, item.id, { checked: !item.checked })
    } catch {
      // The store already toasted; a failed toggle has no state to unwind.
    }
  }

  // Both throw on failure so the add box can put the typed text back; the store has already
  // toasted by then. The checked-match toggle lives in AddItemForm, driven by `checkedItems`.
  async function handleAdd(text: string) {
    await addListItem(listId, text)
    // The new row is the last unchecked one — the pile may sit below it in the scroller.
    scrollToNewestItem(scrollRef.current, 'button[data-checked="false"]')
  }

  async function handleRestore(itemId: string) {
    await updateListItem(listId, itemId, { checked: false })
    // The row returns to its remembered spot, often scrolled out of a cell this short — without
    // this the restore looks like a no-op and gets retyped into a real duplicate.
    scrollToNewestItem(scrollRef.current, `[data-item-id="${itemId}"]`)
  }

  if (error) {
    // A 404/403 means the list itself is gone or no longer shared — retrying can't change that,
    // and saying "try again" would mislead. Anything else is an outage the user can retry.
    const gone = error instanceof ApiError && (error.status === 404 || error.status === 403)
    return gone ? (
      <WidgetErrorState
        title="List unavailable"
        detail="It may have been deleted or removed from this dashboard."
      />
    ) : (
      <WidgetErrorState
        title="Couldn't load this list"
        detail="Check your connection."
        onRetry={refetch}
      />
    )
  }

  if (!detail) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border border-zinc-700 border-t-zinc-500" />
      </div>
    )
  }

  const checkedCount = pile.length
  const total = detail.items.length
  const progress = total > 0 ? (checkedCount / total) * 100 : 0

  const renderRow = (item: ListItem) => (
    <button
      key={item.id}
      type="button"
      data-checked={item.checked}
      data-item-id={item.id}
      onClick={() => void handleToggle(item)}
      className="flex items-start gap-2 w-full text-left px-0.5 py-0.5 rounded hover:bg-zinc-800/50 transition-colors group/item"
    >
      <span
        className={cn(
          'mt-0.5 shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors',
          item.checked
            ? 'bg-blue-500 border-blue-500'
            : 'border-zinc-700 group-hover/item:border-zinc-500',
        )}
      >
        {item.checked && <Check size={9} strokeWidth={3} className="text-white" />}
      </span>
      <span
        className={cn(
          'text-xs flex-1 truncate leading-4 mt-0.5',
          item.checked ? 'line-through text-zinc-600' : 'text-zinc-300',
        )}
      >
        {item.text}
      </span>
      {/* Read-only here — the picker lives on the list page. Overdue is only meaningful for
          an outstanding item, so a checked one stays neutral. */}
      {item.due_date && (
        <span
          className={cn(
            'shrink-0 rounded px-1 py-0.5 text-[9px] tabular-nums leading-none mt-0.5',
            !item.checked && item.due_date < dateKey(startOfDay(new Date()))
              ? 'bg-red-500/10 text-red-400'
              : 'bg-zinc-800 text-zinc-500',
          )}
        >
          {formatCalendarDay(item.due_date)}
        </span>
      )}
    </button>
  )

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      {/* Progress bar */}
      {total > 0 && (
        <div className="shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-600">
              {checkedCount}/{total} done
            </span>
            {/* Free space at the row's end — the toggle costs the tile no extra height,
                and the negative margin keeps it that way at a thumb-sized target. */}
            <button
              type="button"
              onClick={() => setPileEnabled(listId, !pileOn)}
              aria-pressed={pileOn}
              title="Sink checked items into a pile"
              aria-label="Sink checked items into a pile"
              className={cn(
                'shrink-0 p-2 -my-1.5 rounded transition-colors',
                pileOn ? 'text-zinc-300' : 'text-zinc-700 hover:text-zinc-400',
              )}
            >
              <ListChecks size={12} />
            </button>
          </div>
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Item list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
        {(pileOn ? active : detail.items).map(renderRow)}

        {/* Otherwise the tile reads as broken: a full progress bar over an empty body. */}
        {pileOn && total > 0 && active.length === 0 && (
          <p className="text-xs text-zinc-600 px-0.5 py-1">All done.</p>
        )}

        {pileOn && pile.length > 0 && (
          <section aria-label="Checked items" className="space-y-0.5">
            <button
              type="button"
              onClick={() => setPileOpen(!pileOpen)}
              aria-expanded={pileOpen}
              className="w-full flex items-center gap-1 px-0.5 py-0.5 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {pileOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Checked ({pile.length})
            </button>
            {pileOpen && pile.map(renderRow)}
          </section>
        )}

        {total === 0 && <p className="text-xs text-zinc-700 px-0.5 py-1">No items yet.</p>}
      </div>

      {/* Kept at every width: it is the tile's only way in, so it truncates like the rows above
          it rather than going away, which leaves no visible way to add at all. */}
      <AddItemForm
        key={detail.id}
        compact
        onAdd={handleAdd}
        checkedItems={pile}
        onRestore={handleRestore}
      />
    </div>
  )
}
