import { Plus } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useMatch, useNavigate, useSearchParams } from 'react-router'
import {
  apiGetListTrash,
  apiPurgeList,
  type ListSummary,
  type ListType,
  type TrashedList,
} from '../api/lists'
import { PAGE_HEADER_RESERVE } from '../components/layout/pageHeaderReserve'
import { CreateListModal } from '../components/lists/CreateListModal'
import { ListSidebarRow } from '../components/lists/ListSidebarRow'
import { SortableList, useSortableRow } from '../components/lists/SortableList'
import { DashboardSelect } from '../components/ui/DashboardSelect'
import { TrashRow } from '../components/ui/TrashRow'
import { useInitialDashboardSelection } from '../hooks/useInitialDashboardSelection'
import {
  createList,
  deleteList,
  reorderLists,
  restoreList,
  updateListName,
  useListSummaries,
} from '../resources/listData'
import { ROUTES } from '../routes'
import { confirm } from '../stores/confirm'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'
import { cn } from '../utils/shared/cn'

type SidebarRowHandlers = Pick<
  ComponentProps<typeof ListSidebarRow>,
  'selectedId' | 'onSelect' | 'onRename' | 'onDelete'
>

function SortableSidebarRow({
  list,
  sortingEnabled,
  ...handlers
}: { list: ListSummary; sortingEnabled: boolean } & SidebarRowHandlers) {
  const sortable = useSortableRow(list.id, !sortingEnabled)
  return (
    <ListSidebarRow list={list} sortable={sortingEnabled ? sortable : undefined} {...handlers} />
  )
}

const TYPE_FILTERS: { value: ListType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'grocery', label: 'Grocery' },
  { value: 'todo', label: 'Todo' },
]
const VIEW_FILTERS: { value: boolean; label: string }[] = [
  { value: false, label: 'Active' },
  { value: true, label: 'Trash' },
]
const EMPTY_LISTS: ListSummary[] = []
const EMPTY_TRASH: TrashedList[] = []

export function ListsLayout() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailMatch = useMatch(ROUTES.listDetailPattern)
  const listId = detailMatch?.params.listId ?? null

  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)

  const [typeFilter, setTypeFilter] = useState<ListType | 'all'>('all')
  const [showTrash, setShowTrash] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [trash, setTrash] = useState<TrashedList[]>(EMPTY_TRASH)
  const [trashLoading, setTrashLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [purgingId, setPurgingId] = useState<string | null>(null)

  const requestedDashboardId = searchParams.get('dashboard_id')
  const [dashboardId, setDashboardId, dashboardsReady] = useInitialDashboardSelection(
    requestedDashboardId,
    'Failed to load dashboards.',
  )

  const effectiveDashboardId = useMemo(() => {
    if (dashboardId && dashboards.some((d) => d.id === dashboardId)) return dashboardId
    return dashboards[0]?.id ?? null
  }, [dashboards, dashboardId])

  useEffect(() => {
    if (!dashboardsReady) return
    if (effectiveDashboardId === requestedDashboardId) return
    setSearchParams(
      (params) => {
        if (effectiveDashboardId) params.set('dashboard_id', effectiveDashboardId)
        else params.delete('dashboard_id')
        return params
      },
      { replace: true },
    )
  }, [dashboardsReady, effectiveDashboardId, requestedDashboardId, setSearchParams])

  const loadTrash = useCallback(() => {
    if (!effectiveDashboardId) return
    setTrashLoading(true)
    void apiGetListTrash(effectiveDashboardId)
      .then(setTrash)
      .catch(() => setTrash(EMPTY_TRASH))
      .finally(() => setTrashLoading(false))
  }, [effectiveDashboardId])

  // Fetched on demand rather than with the summaries: the trash is a rarely-opened view, and
  // nothing else on the page needs it.
  useEffect(() => {
    if (!showTrash) return
    loadTrash()
  }, [showTrash, loadTrash])

  const listSummariesQuery = useListSummaries(effectiveDashboardId)
  const lists = listSummariesQuery.data ?? EMPTY_LISTS
  const { loading, error: listsError, refetch: refetchLists } = listSummariesQuery

  // The sidebar has two views — Active (default) and Trash. Trashed lists are fetched
  // separately (they are not in the summaries cache at all), and only offer restore.
  const filteredLists =
    typeFilter === 'all' ? lists : lists.filter((l) => l.list_type === typeFilter)
  const filteredTrash =
    typeFilter === 'all' ? trash : trash.filter((l) => l.list_type === typeFilter)
  const activeDashboard = dashboards.find((d) => d.id === effectiveDashboardId) ?? null
  const showVisibleCreate = showCreate && Boolean(effectiveDashboardId)

  // Reordering is offered only for exactly the set the backend renumbers: the unfiltered Active
  // view on a known dashboard with 2+ rows. A filtered or Trash view would diverge from the
  // server's set, so there is no handle at all rather than a drag that 409s.
  const canReorderLists =
    typeFilter === 'all' && !showTrash && effectiveDashboardId != null && filteredLists.length >= 2

  function listUrl(id: string) {
    return `${ROUTES.listDetail(id)}${effectiveDashboardId ? `?dashboard_id=${effectiveDashboardId}` : ''}`
  }

  function indexUrl(dashId: string | null = effectiveDashboardId) {
    return `${ROUTES.lists}${dashId ? `?dashboard_id=${dashId}` : ''}`
  }

  async function handleCreate(name: string, listType: ListType) {
    const trimmedName = name.trim()
    if (!trimmedName || !effectiveDashboardId) return
    try {
      const list = await createList(trimmedName, listType, effectiveDashboardId)
      setShowCreate(false)
      navigate(listUrl(list.id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list.')
    }
  }

  async function handleRenameList(renameListId: string, name: string) {
    const trimmedName = name.trim()
    const currentName = lists.find((l) => l.id === renameListId)?.name
    // Empty names are rejected by the row editor, which can attach the message to the input.
    if (!trimmedName || !currentName || trimmedName === currentName) return
    await updateListName(renameListId, trimmedName)
  }

  async function handleDeleteList(deleteListId: string) {
    const name = lists.find((l) => l.id === deleteListId)?.name
    // Read now, not on the undo click: restoring has to patch the cache of the dashboard the list
    // came from, which may not be the one on screen by then.
    const fromDashboardId = effectiveDashboardId
    try {
      await deleteList(deleteListId)
      // The trash gained a row; refresh it only if the user has it open (or has looked).
      if (trash !== EMPTY_TRASH) void loadTrash()
      if (listId === deleteListId) {
        navigate(indexUrl(), { replace: true })
      }
      // The trash is the way back after this toast; the undo is here because finding it requires
      // knowing it exists.
      toast.success(
        name ? `Moved "${name}" to the trash.` : 'Moved to the trash.',
        fromDashboardId
          ? {
              label: 'Undo',
              onAction: () => void handleUndoDeleteList(deleteListId, fromDashboardId, name),
            }
          : undefined,
      )
    } catch {
      // deleteList already reports the failure
    }
  }

  async function handleUndoDeleteList(
    undoListId: string,
    fromDashboardId: string,
    name: string | undefined,
  ) {
    if (await restoreList(undoListId, fromDashboardId)) {
      if (trash !== EMPTY_TRASH) void loadTrash()
      toast.success(name ? `Restored "${name}".` : 'Restored.')
    }
  }

  async function handleRestoreList(trashed: TrashedList) {
    if (!effectiveDashboardId) return
    setRestoringId(trashed.id)
    try {
      if (await restoreList(trashed.id, effectiveDashboardId)) {
        setTrash((current) => current.filter((l) => l.id !== trashed.id))
        toast.success(`Restored "${trashed.name}".`)
      }
    } finally {
      setRestoringId(null)
    }
  }

  async function handlePurgeList(trashed: TrashedList) {
    // Irreversible, and the only action here that is — say so before doing it.
    const message = `Permanently delete "${trashed.name}"? Its items go with it. This cannot be undone.`
    if (!(await confirm(message, { confirmLabel: 'Delete permanently' }))) return
    setPurgingId(trashed.id)
    try {
      await apiPurgeList(trashed.id)
      setTrash((current) => current.filter((l) => l.id !== trashed.id))
      toast.success(`Permanently deleted "${trashed.name}".`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to permanently delete list.')
    } finally {
      setPurgingId(null)
    }
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col gap-2 shrink-0">
        <div className={cn('flex items-center gap-2 min-w-0 min-h-10', PAGE_HEADER_RESERVE)}>
          <h1 className="min-w-0 flex-1 text-xl font-semibold text-zinc-100 truncate">Lists</h1>
          <DashboardSelect
            value={effectiveDashboardId}
            dashboards={dashboards}
            disabled={dashboardsLoading || dashboards.length === 0}
            onChange={(nextDashboardId) => {
              setShowCreate(false)
              setDashboardId(nextDashboardId)
              navigate(indexUrl(nextDashboardId))
            }}
          />
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            disabled={!effectiveDashboardId}
            className="shrink-0 flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors disabled:text-zinc-700"
          >
            <Plus size={16} />
            New list
          </button>
        </div>
        {!activeDashboard && (
          <p className="text-sm text-zinc-500">Choose a dashboard to work with its lists.</p>
        )}
      </div>

      <div
        className={cn(
          'flex items-center gap-2 shrink-0 overflow-x-auto pb-1',
          listId && 'hidden lg:flex',
        )}
      >
        <div className="flex items-center gap-1 shrink-0">
          {VIEW_FILTERS.map(({ value, label }) => (
            <button
              type="button"
              key={label}
              onClick={() => setShowTrash(value)}
              className={cn(
                'shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors',
                showTrash === value
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="w-px self-stretch bg-zinc-800 shrink-0" />
        <div className="flex items-center gap-1 shrink-0">
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
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden lg:overflow-visible lg:flex lg:flex-row lg:gap-4">
        <div
          className={cn(
            'absolute inset-0 flex flex-col gap-2 overflow-y-auto transition-transform duration-300 ease-in-out',
            'lg:static lg:w-72 lg:shrink-0 lg:translate-x-0 lg:pointer-events-auto',
            listId ? '-translate-x-full pointer-events-none' : 'translate-x-0',
          )}
        >
          {showTrash ? (
            trashLoading ? (
              <p className="text-sm text-zinc-600 px-1">Loading…</p>
            ) : filteredTrash.length === 0 ? (
              <p className="text-sm text-zinc-600 px-1">Nothing in the trash.</p>
            ) : (
              filteredTrash.map((trashed) => (
                <TrashRow
                  key={trashed.id}
                  name={trashed.name}
                  purgeAt={trashed.purge_at}
                  busy={
                    restoringId === trashed.id
                      ? 'restoring'
                      : purgingId === trashed.id
                        ? 'purging'
                        : null
                  }
                  onRestore={() => void handleRestoreList(trashed)}
                  onPurge={() => void handlePurgeList(trashed)}
                />
              ))
            )
          ) : loading ? (
            <p className="text-sm text-zinc-600 px-1">Loading…</p>
          ) : listsError ? (
            <div className="flex flex-col items-start gap-2 px-1">
              <p className="text-sm text-zinc-600">Could not load lists.</p>
              <button
                type="button"
                onClick={refetchLists}
                className="rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
              >
                Try again
              </button>
            </div>
          ) : filteredLists.length === 0 ? (
            <p className="text-sm text-zinc-600 px-1">
              {!effectiveDashboardId
                ? 'Select a dashboard to load its lists.'
                : 'No lists on this dashboard yet.'}
            </p>
          ) : (
            <SortableList
              items={filteredLists}
              onReorder={(orderedIds) => {
                if (effectiveDashboardId) void reorderLists(effectiveDashboardId, orderedIds)
              }}
              disabled={!canReorderLists}
            >
              {(list) => (
                <SortableSidebarRow
                  key={list.id}
                  list={list}
                  sortingEnabled={canReorderLists}
                  selectedId={listId}
                  onSelect={(id) => navigate(listUrl(id))}
                  onRename={handleRenameList}
                  onDelete={handleDeleteList}
                />
              )}
            </SortableList>
          )}
        </div>

        <div
          className={cn(
            'absolute inset-0 flex flex-col transition-transform duration-300 ease-in-out',
            'lg:static lg:flex-1 lg:min-w-0 lg:translate-x-0 lg:pointer-events-auto',
            listId ? 'translate-x-0' : 'translate-x-full pointer-events-none',
          )}
        >
          {listId ? (
            <Outlet />
          ) : (
            <div className="flex-1 min-h-64 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
              <p className="text-sm text-zinc-600">Select a list to view its items</p>
            </div>
          )}
        </div>
      </div>

      {showVisibleCreate && (
        <CreateListModal
          activeDashboardName={activeDashboard?.name}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
