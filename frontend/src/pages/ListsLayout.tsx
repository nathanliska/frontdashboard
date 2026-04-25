import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Outlet, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import type { ListSummary, ListType } from '../api/lists'
import { CreateListCard } from '../components/lists/CreateListCard'
import { ListSidebarRow } from '../components/lists/ListSidebarRow'
import { useInitialDashboardSelection } from '../hooks/useInitialDashboardSelection'
import {
  archiveList,
  createList,
  deleteList,
  updateListName,
  useListSummaries,
} from '../resources/listData'
import { ROUTES } from '../routes'
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

export function ListsLayout() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailMatch = useMatch(ROUTES.listDetailPattern)
  const listId = detailMatch?.params.listId ?? null

  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)

  const [typeFilter, setTypeFilter] = useState<ListType | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)

  const requestedDashboardId = searchParams.get('dashboard_id')
  const [dashboardId, setDashboardId, dashboardsReady] = useInitialDashboardSelection(
    requestedDashboardId,
    'Failed to load dashboards.',
  )

  const activeDashboards = useMemo(() => dashboards.filter((d) => !d.archived), [dashboards])
  const effectiveDashboardId = useMemo(() => {
    if (dashboardId && activeDashboards.some((d) => d.id === dashboardId)) return dashboardId
    return activeDashboards[0]?.id ?? null
  }, [activeDashboards, dashboardId])

  useEffect(() => {
    if (!dashboardsReady) return
    if (effectiveDashboardId === requestedDashboardId) return
    const next = new URLSearchParams(searchParams)
    if (effectiveDashboardId) next.set('dashboard_id', effectiveDashboardId)
    else next.delete('dashboard_id')
    setSearchParams(next, { replace: true })
  }, [dashboardsReady, effectiveDashboardId, requestedDashboardId, searchParams, setSearchParams])

  const listSummariesQuery = useListSummaries(effectiveDashboardId)
  const lists = listSummariesQuery.data ?? EMPTY_LISTS
  const { loading, error: listsError } = listSummariesQuery

  const filteredLists =
    typeFilter === 'all' ? lists : lists.filter((l) => l.list_type === typeFilter)
  const activeDashboard = activeDashboards.find((d) => d.id === effectiveDashboardId) ?? null
  const showVisibleCreate = showCreate && effectiveDashboardId === dashboardId

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
    if (!trimmedName) {
      toast.error('List name cannot be empty.')
      return
    }
    if (!currentName || trimmedName === currentName) return
    await updateListName(renameListId, trimmedName)
  }

  async function handleDeleteList(deleteListId: string) {
    try {
      await deleteList(deleteListId)
      if (listId === deleteListId) {
        navigate(indexUrl(), { replace: true })
      }
    } catch {
      // deleteList already reports the failure
    }
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
              setShowCreate(false)
              setDashboardId(nextDashboardId)
              navigate(indexUrl(nextDashboardId))
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
            onClick={() => setShowCreate((v) => !v)}
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

      <div
        className={cn(
          'flex items-center gap-1 shrink-0 overflow-x-auto pb-1',
          listId && 'hidden lg:flex',
        )}
      >
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

      <div className="relative flex-1 min-h-0 overflow-hidden lg:overflow-visible lg:flex lg:flex-row lg:gap-4">
        <div
          className={cn(
            'absolute inset-0 flex flex-col gap-2 overflow-y-auto transition-transform duration-300 ease-in-out',
            'lg:static lg:w-72 lg:shrink-0 lg:translate-x-0 lg:pointer-events-auto',
            listId ? '-translate-x-full pointer-events-none' : 'translate-x-0',
          )}
        >
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
                selectedId={listId}
                onSelect={(id) => navigate(listUrl(id))}
                onRename={handleRenameList}
                onArchive={archiveList}
                onDelete={handleDeleteList}
              />
            ))
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
    </div>
  )
}
