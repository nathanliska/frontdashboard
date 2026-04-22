import { Plus } from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import type { ListSummary, ListType } from '../api/lists'
import { AddItemForm } from '../components/lists/AddItemForm'
import { CreateListCard } from '../components/lists/CreateListCard'
import { EditableListName } from '../components/lists/EditableListName'
import { ListItemRow } from '../components/lists/ListItemRow'
import { ListSidebarRow } from '../components/lists/ListSidebarRow'
import { TypeBadge } from '../components/lists/TypeBadge'
import { useInitialDashboardSelection } from '../hooks/useInitialDashboardSelection'
import {
  addListItem,
  archiveList,
  createList,
  deleteList,
  deleteListItem,
  updateListItem,
  updateListName,
  useListDetail,
  useListSummaries,
} from '../resources/listData'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'
import { cn } from '../utils/shared/cn'

const TYPE_FILTERS: { value: ListType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'grocery', label: 'Grocery' },
  { value: 'todo', label: 'Todo' },
]
const EMPTY_LISTS: ListSummary[] = []

export function ListsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)

  const [typeFilter, setTypeFilter] = useState<ListType | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)

  const location = useLocation()
  const requestedDashboardId = searchParams.get('dashboard_id')
  const requestedListId = searchParams.get('list_id')
  const openListId = (location.state as { openListId?: string } | null)?.openListId ?? null
  const consumedStateOpenListId = useRef(false)
  const [dashboardId, setDashboardId] = useInitialDashboardSelection(
    requestedDashboardId,
    'Failed to load dashboards.',
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const activeDashboards = useMemo(
    () => dashboards.filter((dashboard) => !dashboard.archived),
    [dashboards],
  )
  const effectiveDashboardId = useMemo(() => {
    if (dashboardId && activeDashboards.some((dashboard) => dashboard.id === dashboardId)) {
      return dashboardId
    }
    return activeDashboards[0]?.id ?? null
  }, [activeDashboards, dashboardId])
  const listSummariesQuery = useListSummaries(effectiveDashboardId)
  const detailQuery = useListDetail(selectedId)
  const lists = listSummariesQuery.data ?? EMPTY_LISTS
  const { loading, error: listsError } = listSummariesQuery
  const detail = detailQuery.data
  const detailError = detailQuery.error
  const updateRouteSelection = useEffectEvent(
    (nextDashboardId: string | null, nextListId: string | null, replace = false) => {
      const nextSearchParams = new URLSearchParams(searchParams)
      if (nextDashboardId) {
        nextSearchParams.set('dashboard_id', nextDashboardId)
      } else {
        nextSearchParams.delete('dashboard_id')
      }
      if (nextListId) {
        nextSearchParams.set('list_id', nextListId)
      } else {
        nextSearchParams.delete('list_id')
      }

      if (nextSearchParams.toString() !== searchParams.toString()) {
        setSearchParams(nextSearchParams, { replace })
      }
    },
  )
  const openRequestedList = useEffectEvent((listId: string, replace = false) => {
    setSelectedId(listId)
    updateRouteSelection(effectiveDashboardId, listId, replace)
  })
  const clearMissingSelectedList = useEffectEvent(() => {
    setSelectedId(null)
    updateRouteSelection(effectiveDashboardId, null, true)
  })

  useEffect(() => {
    if (effectiveDashboardId === requestedDashboardId) return
    updateRouteSelection(effectiveDashboardId, selectedId, true)
  }, [effectiveDashboardId, requestedDashboardId, selectedId])

  useEffect(() => {
    if (!requestedListId || loading) return
    if (!lists.some((list) => list.id === requestedListId)) {
      updateRouteSelection(effectiveDashboardId, null, true)
      return
    }
    if (selectedId !== requestedListId) {
      setSelectedId(requestedListId)
    }
  }, [effectiveDashboardId, lists, loading, requestedListId, selectedId])

  useEffect(() => {
    if (requestedListId || consumedStateOpenListId.current || !openListId || loading) return
    if (!lists.some((list) => list.id === openListId)) return
    consumedStateOpenListId.current = true
    openRequestedList(openListId, true)
  }, [lists, loading, openListId, requestedListId])

  useEffect(() => {
    if (!selectedId || loading) return
    if (!lists.some((list) => list.id === selectedId)) {
      clearMissingSelectedList()
    }
  }, [lists, loading, selectedId])

  const filteredLists =
    typeFilter === 'all' ? lists : lists.filter((list) => list.list_type === typeFilter)
  const activeDashboard = activeDashboards.find((item) => item.id === effectiveDashboardId) ?? null
  const showVisibleCreate = showCreate && effectiveDashboardId === dashboardId

  async function handleCreate(name: string, listType: ListType) {
    const trimmedName = name.trim()
    if (!trimmedName || !effectiveDashboardId) return

    try {
      const list = await createList(trimmedName, listType, effectiveDashboardId)
      openRequestedList(list.id)
      setShowCreate(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list.')
    }
  }

  async function handleAddItem(text: string) {
    const trimmedText = text.trim()
    if (!trimmedText || !selectedId) return
    await addListItem(selectedId, trimmedText)
  }

  function selectList(id: string) {
    openRequestedList(id)
  }

  async function submitListNameEdit(name: string) {
    if (!detail) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('List name cannot be empty.')
      return
    }
    if (trimmedName === detail.name) return
    await updateListName(detail.id, trimmedName)
  }

  async function submitSidebarListNameEdit(listId: string, name: string) {
    const trimmedName = name.trim()
    const currentName = lists.find((list) => list.id === listId)?.name
    if (!trimmedName) {
      toast.error('List name cannot be empty.')
      return
    }
    if (!currentName || trimmedName === currentName) return
    await updateListName(listId, trimmedName)
  }

  async function handleDeleteList(listId: string) {
    await deleteList(listId)
    if (selectedId === listId) {
      setSelectedId(null)
    }
  }

  async function handleDeleteItem(itemId: string) {
    if (!selectedId) return
    await deleteListItem(selectedId, itemId)
  }

  async function handleRenameItem(itemId: string, text: string) {
    const trimmedText = text.trim()
    const currentText = detail?.items.find((item) => item.id === itemId)?.text
    if (!trimmedText) {
      toast.error('Item name cannot be empty.')
      return
    }
    if (!selectedId || !currentText || trimmedText === currentText) return
    await updateListItem(selectedId, itemId, { text: trimmedText })
  }

  async function handleToggleItem(itemId: string, checked: boolean) {
    if (!selectedId) return
    await updateListItem(selectedId, itemId, { checked })
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 pl-12 sm:pl-0 min-h-10">
          <h1 className="min-w-0 flex-1 text-xl font-semibold text-zinc-100 truncate">Lists</h1>
          <select
            value={effectiveDashboardId ?? ''}
            disabled={dashboardsLoading || dashboards.length === 0}
            onChange={(event) => {
              const nextDashboardId = event.target.value || null
              setSelectedId(null)
              setShowCreate(false)
              setDashboardId(nextDashboardId)
              updateRouteSelection(nextDashboardId, null)
            }}
            className="min-w-0 max-w-44 sm:max-w-none flex-1 lg:flex-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
          >
            <option value="">Select dashboard</option>
            {activeDashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowCreate((value) => !value)}
            disabled={!effectiveDashboardId}
            className="shrink-0 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors disabled:text-zinc-700"
          >
            <Plus size={16} />
            New list
          </button>
        </div>
        <p className="text-sm text-zinc-500">
          {activeDashboard
            ? `Detailed editing for ${activeDashboard.name}. Dashboard permissions apply automatically.`
            : 'Choose a dashboard to work with its lists.'}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0 overflow-x-auto pb-1">
        {TYPE_FILTERS.map(({ value, label }) => (
          <button
            type="button"
            key={value}
            onClick={() => setTypeFilter(value)}
            className={cn(
              'shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors',
              typeFilter === value
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 min-h-0 flex-col gap-4 lg:flex-row">
        <div className="w-full lg:w-72 lg:shrink-0 flex flex-col gap-2 overflow-y-auto">
          {showVisibleCreate && (
            <CreateListCard
              activeDashboardName={activeDashboard?.name}
              onCreate={handleCreate}
              onClose={() => setShowCreate(false)}
            />
          )}

          {loading ? (
            <p className="text-sm text-zinc-600 px-1">Loading…</p>
          ) : listsError ? (
            <p className="text-sm text-zinc-600 px-1">Could not load lists.</p>
          ) : filteredLists.length === 0 ? (
            <p className="text-sm text-zinc-600 px-1">
              {effectiveDashboardId
                ? 'No lists on this dashboard yet.'
                : 'Select a dashboard to load its lists.'}
            </p>
          ) : (
            filteredLists.map((list) => (
              <ListSidebarRow
                key={list.id}
                list={list}
                selectedId={selectedId}
                onSelect={selectList}
                onRename={submitSidebarListNameEdit}
                onArchive={archiveList}
                onDelete={handleDeleteList}
              />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col min-h-104 lg:min-h-0">
          {!selectedId ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
              <p className="text-sm text-zinc-600">Select a list to view its items</p>
            </div>
          ) : !detail ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
              {detailError ? (
                <p className="text-sm text-zinc-600">Could not load this list.</p>
              ) : (
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
              )}
            </div>
          ) : (
            <div className="flex flex-col h-full bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-3 sm:px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
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

              <div className="flex-1 overflow-y-auto">
                {detail.items.length === 0 ? (
                  <p className="text-sm text-zinc-600 px-4 py-6">No items yet.</p>
                ) : (
                  <ul>
                    {detail.items.map((item) => (
                      <ListItemRow
                        key={item.id}
                        item={item}
                        onToggleChecked={handleToggleItem}
                        onRename={handleRenameItem}
                        onDelete={handleDeleteItem}
                      />
                    ))}
                  </ul>
                )}
              </div>

              {!detail.archived && <AddItemForm key={detail.id} onAdd={handleAddItem} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
