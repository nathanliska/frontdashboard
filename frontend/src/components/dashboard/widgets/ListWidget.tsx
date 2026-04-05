import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import {
  type ListDetail,
  type ListItem,
  apiCreateItem,
  apiGetList,
  apiUpdateItem,
} from '../../../api/lists'
import { useDashboardStore } from '../../../stores/dashboard'
import { cn } from '../../../utils/cn'

export function ListWidget({
  listId,
  widgetId,
  config,
}: {
  listId: string
  widgetId: string
  config: Record<string, unknown>
}) {
  const [detail, setDetail] = useState<ListDetail | null>(null)
  const [error, setError] = useState(false)
  const [addText, setAddText] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(300)
  const updateWidget = useDashboardStore((s) => s.updateWidget)
  const listContentVersion = useDashboardStore((s) => s.listContentVersion)

  useEffect(() => {
    apiGetList(listId)
      .then((data) => {
        setDetail(data)
        setError(false)
      })
      .catch(() => setError(true))
  }, [listContentVersion, listId])

  useEffect(() => {
    if (!detail) return

    const currentName = typeof config.list_name === 'string' ? config.list_name : ''
    const currentType = typeof config.list_type === 'string' ? config.list_type : ''
    if (currentName === detail.name && currentType === detail.list_type) return

    void updateWidget(widgetId, {
      ...config,
      list_name: detail.name,
      list_type: detail.list_type,
    })
  }, [config, detail, updateWidget, widgetId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  async function handleToggle(item: ListItem) {
    if (!detail) return
    const updated = await apiUpdateItem(listId, item.id, { checked: !item.checked })
    setDetail((d) =>
      d ? { ...d, items: d.items.map((i) => (i.id === item.id ? updated : i)) } : null,
    )
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!addText.trim() || !detail) return
    const item = await apiCreateItem(listId, addText.trim())
    setDetail((d) => (d ? { ...d, items: [...d.items, item], item_count: d.item_count + 1 } : null))
    setAddText('')
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1">
        <p className="text-xs text-zinc-600">List unavailable</p>
        <p className="text-[10px] text-zinc-700">
          It may have been deleted or removed from this dashboard.
        </p>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border border-zinc-700 border-t-zinc-500" />
      </div>
    )
  }

  const checkedCount = detail.items.filter((i) => i.checked).length
  const total = detail.items.length
  const progress = total > 0 ? (checkedCount / total) * 100 : 0

  // Size thresholds (px)
  const isTiny = containerWidth < 180
  const maxItems = containerWidth < 240 ? 3 : containerWidth < 360 ? 6 : undefined
  const visibleItems = maxItems != null ? detail.items.slice(0, maxItems) : detail.items
  const hiddenCount = total - visibleItems.length

  return (
    <div ref={containerRef} className="flex flex-col gap-2 h-full">
      {/* Progress bar */}
      {total > 0 && (
        <div className="shrink-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-600">
              {checkedCount}/{total} done
            </span>
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
      <div className="flex-1 overflow-y-auto space-y-0.5 min-h-0">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            type="button"
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
                'text-xs flex-1 truncate leading-tight mt-0.5',
                item.checked ? 'line-through text-zinc-600' : 'text-zinc-300',
              )}
            >
              {item.text}
            </span>
          </button>
        ))}

        {hiddenCount > 0 && (
          <p className="text-[10px] text-zinc-600 px-0.5 pt-0.5">+{hiddenCount} more</p>
        )}

        {total === 0 && <p className="text-xs text-zinc-700 px-0.5 py-1">No items yet.</p>}
      </div>

      {/* Add item */}
      {!isTiny && (
        <form
          onSubmit={(e) => void handleAdd(e)}
          className="flex items-center gap-1.5 shrink-0 border-t border-zinc-800 pt-2"
        >
          <input
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            placeholder="Add item…"
            className="flex-1 bg-transparent text-xs text-zinc-400 placeholder-zinc-700 focus:outline-none min-w-0"
          />
          {addText.trim() && (
            <button
              type="submit"
              className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-label="Add"
            >
              <Plus size={12} />
            </button>
          )}
        </form>
      )}
    </div>
  )
}
