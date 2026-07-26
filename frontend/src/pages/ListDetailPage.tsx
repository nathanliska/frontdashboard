import { ArrowLeft } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useEffect, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import type { ListItem } from '../api/lists'
import { AddItemForm } from '../components/lists/AddItemForm'
import { EditableListName } from '../components/lists/EditableListName'
import { ListItemRow } from '../components/lists/ListItemRow'
import { SortableList, useSortableRow } from '../components/lists/SortableList'
import { TypeBadge } from '../components/lists/TypeBadge'
import {
  addListItem,
  deleteListItem,
  reorderListItems,
  updateListItem,
  updateListName,
  useListDetail,
} from '../resources/listData'
import { ROUTES } from '../routes'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'
import { scrollToNewestItem } from '../utils/shared/scrollToNewestItem'

type ItemHandlers = Pick<
  ComponentProps<typeof ListItemRow>,
  'onToggleChecked' | 'onRename' | 'onDelete'
>

function SortableItemRow({
  item,
  sortingEnabled,
  ...handlers
}: { item: ListItem; sortingEnabled: boolean } & ItemHandlers) {
  const sortable = useSortableRow(item.id, !sortingEnabled)
  return <ListItemRow item={item} sortable={sortingEnabled ? sortable : undefined} {...handlers} />
}

export function ListDetailPage() {
  // listId is always defined — this component only mounts when the :listId route is matched
  const { listId } = useParams() as { listId: string }
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const dashboards = useDashboardStore((s) => s.summaries)

  const scrollRef = useRef<HTMLDivElement>(null)

  const detailQuery = useListDetail(listId ?? null)
  const detail = detailQuery.data
  const detailError = detailQuery.error

  const activeDashboard = detail
    ? (dashboards.find((d) => d.id === detail.dashboard_id) ?? null)
    : null

  const dashboardId = searchParams.get('dashboard_id')
  const indexUrl = `${ROUTES.lists}${dashboardId ? `?dashboard_id=${dashboardId}` : ''}`

  useEffect(() => {
    if (detailError) navigate(indexUrl, { replace: true })
  }, [detailError, navigate, indexUrl])

  async function handleAddItem(text: string) {
    const trimmedText = text.trim()
    if (!trimmedText) return
    await addListItem(listId, trimmedText)
    scrollToNewestItem(scrollRef.current)
  }

  async function submitListNameEdit(name: string) {
    if (!detail) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('List name cannot be empty.')
      return
    }
    if (trimmedName === detail.name) return
    await updateListName(listId, trimmedName)
  }

  async function handleDeleteItem(itemId: string) {
    await deleteListItem(listId, itemId)
  }

  async function handleRenameItem(itemId: string, text: string) {
    const trimmedText = text.trim()
    const currentText = detail?.items.find((item) => item.id === itemId)?.text
    if (!trimmedText) {
      toast.error('Item name cannot be empty.')
      return
    }
    if (!currentText || trimmedText === currentText) return
    await updateListItem(listId, itemId, { text: trimmedText })
  }

  async function handleToggleItem(itemId: string, checked: boolean) {
    await updateListItem(listId, itemId, { checked })
  }

  const sortingEnabled = !!detail && !detail.archived && detail.items.length >= 2

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
        {detailError ? (
          <p className="text-sm text-zinc-600">Could not load this list.</p>
        ) : (
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-3 sm:px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
        <button
          type="button"
          onClick={() => navigate(indexUrl)}
          className="lg:hidden flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-100 transition-colors shrink-0"
          aria-label="Back to lists"
        >
          <ArrowLeft size={16} />
          <span className="text-xs">Lists</span>
        </button>
        <EditableListName
          key={detail.id}
          name={detail.name}
          activeDashboardName={activeDashboard?.name}
          onRename={submitListNameEdit}
        />
        <TypeBadge type={detail.list_type} />
        {detail.archived && (
          <span className="text-xs text-amber-600 sm:ml-auto">Archived — no new items</span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {detail.items.length === 0 ? (
          <p className="text-sm text-zinc-600 px-4 py-6">No items yet.</p>
        ) : (
          <ul>
            <SortableList
              items={detail.items}
              onReorder={(orderedIds) => void reorderListItems(listId, orderedIds)}
              disabled={!sortingEnabled}
            >
              {(item) => (
                <SortableItemRow
                  key={item.id}
                  item={item}
                  sortingEnabled={sortingEnabled}
                  onToggleChecked={handleToggleItem}
                  onRename={handleRenameItem}
                  onDelete={handleDeleteItem}
                />
              )}
            </SortableList>
          </ul>
        )}
      </div>

      {!detail.archived && <AddItemForm key={detail.id} onAdd={handleAddItem} />}
    </div>
  )
}
