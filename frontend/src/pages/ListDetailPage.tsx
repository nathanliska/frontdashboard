import { ArrowLeft, ChevronDown, ChevronRight, ListChecks } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useMemo, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import type { ListItem } from '../api/lists'
import { AddItemForm } from '../components/lists/AddItemForm'
import {
  mergeActiveOrder,
  partitionItems,
  setPileEnabled,
  setPileExpanded,
  usePileEnabled,
  usePileExpanded,
} from '../components/lists/checkedPile'
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
import { cn } from '../utils/shared/cn'
import { scrollToNewestItem } from '../utils/shared/scrollToNewestItem'

type ItemHandlers = Pick<
  ComponentProps<typeof ListItemRow>,
  'onToggleChecked' | 'onRename' | 'onSetDueDate' | 'onDelete'
>

function SortableItemRow({
  item,
  sortingEnabled,
  indentForHandle,
  ...handlers
}: { item: ListItem; sortingEnabled: boolean; indentForHandle: boolean } & ItemHandlers) {
  const sortable = useSortableRow(item.id, !sortingEnabled)
  return (
    <ListItemRow
      item={item}
      sortable={sortingEnabled ? sortable : undefined}
      indentForHandle={indentForHandle}
      {...handlers}
    />
  )
}

export function ListDetailPage() {
  // listId is always defined — this component only mounts when the :listId route is matched
  const { listId } = useParams() as { listId: string }
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const dashboards = useDashboardStore((s) => s.summaries)

  const scrollRef = useRef<HTMLDivElement>(null)

  const pileEnabled = usePileEnabled(listId)
  const pileExpanded = usePileExpanded(listId)

  const detailQuery = useListDetail(listId ?? null)
  const detail = detailQuery.data
  const detailError = detailQuery.error

  // Partitioned regardless of display mode: the add box suggests from the pile either way.
  const { active: partitionedActive, pile } = useMemo(
    () => (detail ? partitionItems(detail.items) : { active: [], pile: [] }),
    [detail],
  )

  const activeDashboard = detail
    ? (dashboards.find((d) => d.id === detail.dashboard_id) ?? null)
    : null

  const dashboardId = searchParams.get('dashboard_id')
  const indexUrl = `${ROUTES.lists}${dashboardId ? `?dashboard_id=${dashboardId}` : ''}`

  function togglePile() {
    setPileEnabled(listId, !pileEnabled)
  }

  function togglePileExpanded() {
    setPileExpanded(listId, !pileExpanded)
  }

  async function handleAddItem(text: string) {
    const trimmedText = text.trim()
    if (!trimmedText) return
    await addListItem(listId, trimmedText)
    // The new row is the last ACTIVE one — plain bottom-of-scroller would land on the pile.
    scrollToNewestItem(scrollRef.current, '[data-list-zone="active"] li:last-of-type')
  }

  async function handleRestoreItem(itemId: string) {
    // Throws on failure so the add box can put the typed text back.
    await updateListItem(listId, itemId, { checked: false })
    // The row returns to its remembered spot, often far above the add box — without this
    // the restore looks like a no-op and gets retyped into a real duplicate.
    scrollToNewestItem(scrollRef.current, `[data-item-id="${itemId}"]`)
  }

  async function submitListNameEdit(name: string) {
    if (!detail) return
    const trimmedName = name.trim()
    // Empty names are rejected by the inline editor, which attaches the message to the input.
    if (!trimmedName || trimmedName === detail.name) return
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
    try {
      await updateListItem(listId, itemId, { checked })
    } catch {
      // The store already toasted; a failed toggle has no state to unwind.
    }
  }

  async function handleSetDueDate(itemId: string, dueDate: string | null) {
    // Rethrows so the row's date picker stays open for a retry.
    await updateListItem(listId, itemId, { due_date: dueDate })
  }

  function handleReorder(orderedIds: string[]) {
    if (!detail) return
    if (!pileEnabled) {
      void reorderListItems(listId, orderedIds)
      return
    }
    const merged = mergeActiveOrder(detail.items, orderedIds)
    if (!merged) {
      // The list changed under the drag. Same wording as the 409 path: the drop is lost
      // either way, and a silent no-op reorder would just look like the drag failed.
      toast.error('Could not save order — refreshed.')
      void detailQuery.refetch()
      return
    }
    void reorderListItems(listId, merged)
  }

  const itemHandlers: ItemHandlers = {
    onToggleChecked: handleToggleItem,
    onRename: handleRenameItem,
    onSetDueDate: handleSetDueDate,
    onDelete: handleDeleteItem,
  }

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
        {detailError ? (
          // Said rather than silently redirected: bouncing a stale bookmark to the index with no
          // explanation reads as the app ignoring the click.
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-zinc-400">
              Could not load this list. It may have been moved to the trash, or you may no longer
              have access to it.
            </p>
            <button
              type="button"
              onClick={() => navigate(indexUrl, { replace: true })}
              className="flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
            >
              <ArrowLeft size={14} />
              Back to lists
            </button>
          </div>
        ) : (
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
        )}
      </div>
    )
  }

  const active = pileEnabled ? partitionedActive : detail.items
  const sortingEnabled = active.length >= 2
  // Reserved from the list, not from how many happen to be unchecked: tie it to the active
  // count and checking the second-to-last item shifts every remaining row left.
  const reserveHandle = detail.items.length >= 2

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
        <button
          type="button"
          onClick={togglePile}
          aria-pressed={pileEnabled}
          // One stable name + aria-pressed for state: a name that flips with the state reads
          // as announcing the action just performed, inverting what activation will do.
          title="Sink checked items into a pile"
          aria-label="Sink checked items into a pile"
          // Padded out to a thumb-sized target, pulled back in by the margin so the header
          // row keeps the height the taller title already sets.
          className={cn(
            'ml-auto shrink-0 p-2.5 -my-1.5 rounded transition-colors',
            pileEnabled ? 'text-zinc-200 bg-zinc-800' : 'text-zinc-600 hover:text-zinc-300',
          )}
        >
          <ListChecks size={16} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {detail.items.length === 0 ? (
          <p className="text-sm text-zinc-600 px-4 py-6">No items yet.</p>
        ) : (
          <>
            {active.length === 0 ? (
              <p className="text-sm text-zinc-600 px-4 py-6">All checked.</p>
            ) : (
              <ul data-list-zone="active">
                <SortableList items={active} onReorder={handleReorder} disabled={!sortingEnabled}>
                  {(item) => (
                    <SortableItemRow
                      key={item.id}
                      item={item}
                      sortingEnabled={sortingEnabled}
                      indentForHandle={!sortingEnabled && reserveHandle}
                      {...itemHandlers}
                    />
                  )}
                </SortableList>
              </ul>
            )}
            {pileEnabled && pile.length > 0 && (
              <section aria-label="Checked items">
                <button
                  type="button"
                  onClick={togglePileExpanded}
                  aria-expanded={pileExpanded}
                  className="w-full flex items-center gap-1.5 px-3 sm:px-4 py-2 border-t border-zinc-800 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {pileExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Checked ({pile.length})
                </button>
                {pileExpanded && (
                  <ul>
                    {pile.map((item) => (
                      <ListItemRow
                        key={item.id}
                        item={item}
                        indentForHandle={reserveHandle}
                        {...itemHandlers}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <AddItemForm
        key={detail.id}
        onAdd={handleAddItem}
        checkedItems={pile}
        onRestore={handleRestoreItem}
      />
    </div>
  )
}
