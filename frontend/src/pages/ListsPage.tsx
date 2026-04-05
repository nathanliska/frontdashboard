import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Archive, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { ListType } from '../api/lists'
import { useDashboardStore } from '../stores/dashboard'
import { useListsStore } from '../stores/lists'
import { toast } from '../stores/toast'
import { cn } from '../utils/cn'

const TYPE_FILTERS: { value: ListType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'checklist', label: 'Checklist' },
  { value: 'grocery', label: 'Grocery' },
  { value: 'todo', label: 'Todo' },
]

export function ListsPage() {
  const {
    lists,
    selectedId,
    detail,
    loading,
    dashboardId,
    loadLists,
    clearSelection,
    selectList,
    createList,
    updateListName,
    deleteList,
    archiveList,
    addItem,
    updateItemText,
    toggleItem,
    deleteItem,
  } = useListsStore()
  const dashboards = useDashboardStore((s) => s.summaries)
  const dashboardsLoading = useDashboardStore((s) => s.summariesLoading)
  const loadSummaries = useDashboardStore((s) => s.loadSummaries)

  const [typeFilter, setTypeFilter] = useState<ListType | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<ListType>('checklist')
  const [addText, setAddText] = useState('')
  const [editingListName, setEditingListName] = useState(false)
  const [listNameDraft, setListNameDraft] = useState('')
  const [editingSidebarListId, setEditingSidebarListId] = useState<string | null>(null)
  const [sidebarListNameDraft, setSidebarListNameDraft] = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItemText, setEditingItemText] = useState('')
  const [confirmingListDeleteId, setConfirmingListDeleteId] = useState<string | null>(null)
  const [confirmingItemDeleteId, setConfirmingItemDeleteId] = useState<string | null>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const listNameInputRef = useRef<HTMLInputElement>(null)
  const sidebarListNameInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

  const location = useLocation()
  const searchParams = new URLSearchParams(location.search)
  const requestedDashboardId = searchParams.get('dashboard_id')
  const openListId = (location.state as { openListId?: string } | null)?.openListId
  const didAutoOpen = useRef(false)

  useEffect(() => {
    void (async () => {
      try {
        await loadSummaries()
        const items = useDashboardStore.getState().summaries
        const nextDashboardId =
          requestedDashboardId ?? items.find((item) => item.is_favorite)?.id ?? items[0]?.id ?? null
        if (nextDashboardId) {
          await loadLists(nextDashboardId)
        }
      } catch {
        toast.error('Failed to load dashboards.')
      }
    })()
  }, [loadLists, loadSummaries, requestedDashboardId])

  useEffect(() => {
    if (openListId && !loading && !didAutoOpen.current) {
      didAutoOpen.current = true
      void selectList(openListId)
    }
  }, [openListId, loading, selectList])

  useEffect(() => {
    if (!editingListName) return
    listNameInputRef.current?.focus()
    listNameInputRef.current?.select()
  }, [editingListName])

  useEffect(() => {
    if (!editingSidebarListId) return
    sidebarListNameInputRef.current?.focus()
    sidebarListNameInputRef.current?.select()
  }, [editingSidebarListId])

  useEffect(() => {
    if (!editingItemId) return
    editInputRef.current?.focus()
    editInputRef.current?.select()
  }, [editingItemId])

  const filteredLists =
    typeFilter === 'all' ? lists : lists.filter((list) => list.list_type === typeFilter)
  const activeDashboard = dashboards.find((item) => item.id === dashboardId) ?? null

  async function handleCreate(event: React.SyntheticEvent) {
    event.preventDefault()
    const name = newName.trim()
    if (!name || !dashboardId) return

    try {
      await createList(name, newType, dashboardId)
      setNewName('')
      setShowCreate(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create list.')
    }
  }

  async function handleAddItem(event: React.SyntheticEvent) {
    event.preventDefault()
    const text = addText.trim()
    if (!text) return
    setAddText('')
    await addItem(text)
    addInputRef.current?.focus()
  }

  function startEditingListName(name: string) {
    setEditingListName(true)
    setListNameDraft(name)
  }

  function cancelEditingListName() {
    setEditingListName(false)
    setListNameDraft('')
  }

  async function submitListNameEdit() {
    if (!detail) return
    const name = listNameDraft.trim()
    if (!name) {
      toast.error('List name cannot be empty.')
      return
    }
    if (name === detail.name) {
      cancelEditingListName()
      return
    }
    try {
      await updateListName(detail.id, name)
      cancelEditingListName()
    } catch {
      // store handles toast
    }
  }

  function startEditingSidebarListName(listId: string, name: string) {
    setConfirmingListDeleteId(null)
    setEditingSidebarListId(listId)
    setSidebarListNameDraft(name)
  }

  function cancelEditingSidebarListName() {
    setEditingSidebarListId(null)
    setSidebarListNameDraft('')
  }

  async function submitSidebarListNameEdit(listId: string) {
    const name = sidebarListNameDraft.trim()
    const currentName = lists.find((list) => list.id === listId)?.name
    if (!name) {
      toast.error('List name cannot be empty.')
      return
    }
    if (!currentName || name === currentName) {
      cancelEditingSidebarListName()
      return
    }
    try {
      await updateListName(listId, name)
      cancelEditingSidebarListName()
    } catch {
      // store handles toast
    }
  }

  async function confirmDeleteList(listId: string) {
    setConfirmingListDeleteId(null)
    await deleteList(listId)
  }

  async function confirmDeleteItem(itemId: string) {
    setConfirmingItemDeleteId(null)
    await deleteItem(itemId)
  }

  function startEditingItem(itemId: string, text: string) {
    setEditingItemId(itemId)
    setEditingItemText(text)
  }

  function cancelEditingItem() {
    setEditingItemId(null)
    setEditingItemText('')
  }

  async function submitItemEdit(itemId: string) {
    const text = editingItemText.trim()
    const currentText = detail?.items.find((item) => item.id === itemId)?.text
    if (!text) {
      toast.error('Item name cannot be empty.')
      return
    }
    if (!currentText || text === currentText) {
      cancelEditingItem()
      return
    }
    try {
      await updateItemText(itemId, text)
      cancelEditingItem()
    } catch {
      // store handles toast
    }
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 pl-12 sm:pl-0 min-h-10">
          <h1 className="min-w-0 flex-1 text-xl font-semibold text-zinc-100 truncate">Lists</h1>
          <select
            value={dashboardId ?? ''}
            disabled={dashboardsLoading || dashboards.length === 0}
            onChange={(event) => {
              const nextDashboardId = event.target.value || null
              clearSelection()
              setShowCreate(false)
              if (nextDashboardId) {
                void loadLists(nextDashboardId)
              }
            }}
            className="min-w-0 max-w-[11rem] sm:max-w-none flex-1 lg:flex-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
          >
            <option value="">Select dashboard</option>
            {dashboards.map((dashboard) => (
              <option key={dashboard.id} value={dashboard.id}>
                {dashboard.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCreate((value) => !value)}
            disabled={!dashboardId}
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
          {showCreate && (
            <form
              onSubmit={handleCreate}
              className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 space-y-2 shrink-0"
            >
              <input
                autoFocus
                placeholder="List name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <select
                value={newType}
                onChange={(event) => setNewType(event.target.value as ListType)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500"
              >
                <option value="checklist">Checklist</option>
                <option value="grocery">Grocery</option>
                <option value="todo">Todo</option>
              </select>
              <p className="text-xs text-zinc-500">
                This list will belong to {activeDashboard?.name ?? 'the selected dashboard'}.
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 bg-zinc-100 text-zinc-900 rounded-md py-1.5 text-xs font-medium hover:bg-zinc-200 transition-colors"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <p className="text-sm text-zinc-600 px-1">Loading…</p>
          ) : filteredLists.length === 0 ? (
            <p className="text-sm text-zinc-600 px-1">
              {dashboardId
                ? 'No lists on this dashboard yet.'
                : 'Select a dashboard to load its lists.'}
            </p>
          ) : (
            filteredLists.map((list) => (
              <ListSidebarRow
                key={list.id}
                list={list}
                selectedId={selectedId}
                editingSidebarListId={editingSidebarListId}
                sidebarListNameDraft={sidebarListNameDraft}
                sidebarListNameInputRef={sidebarListNameInputRef}
                confirmingListDeleteId={confirmingListDeleteId}
                onSelect={selectList}
                onDraftChange={setSidebarListNameDraft}
                onSubmitEdit={submitSidebarListNameEdit}
                onCancelEdit={cancelEditingSidebarListName}
                onStartEdit={startEditingSidebarListName}
                onArchive={archiveList}
                onAskDelete={setConfirmingListDeleteId}
                onConfirmDelete={confirmDeleteList}
              />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col min-h-[26rem] lg:min-h-0">
          {!selectedId ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
              <p className="text-sm text-zinc-600">Select a list to view its items</p>
            </div>
          ) : !detail ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/40">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
            </div>
          ) : (
            <div className="flex flex-col h-full bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-3 sm:px-4 py-3 border-b border-zinc-800 flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
                {editingListName ? (
                  <input
                    ref={listNameInputRef}
                    value={listNameDraft}
                    onChange={(event) => setListNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void submitListNameEdit()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelEditingListName()
                      }
                    }}
                    className="min-w-0 flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-medium text-zinc-100 focus:outline-none focus:border-zinc-500"
                  />
                ) : (
                  <span className="min-w-0 flex-1 text-sm sm:text-base font-medium text-zinc-100 truncate">
                    {detail.name}
                  </span>
                )}
                {editingListName ? (
                  <>
                    <p className="order-last basis-full sm:order-none sm:basis-auto text-xs text-zinc-500">
                      Managed by {activeDashboard?.name ?? 'this dashboard'}.
                    </p>
                    <button
                      type="button"
                      onClick={() => void submitListNameEdit()}
                      className="p-0.5 text-zinc-500 hover:text-zinc-100"
                      aria-label="Save list name"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditingListName}
                      className="p-0.5 text-zinc-500 hover:text-zinc-300"
                      aria-label="Cancel editing list name"
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => startEditingListName(detail.name)}
                    className="p-0.5 text-zinc-500 hover:text-zinc-300"
                    aria-label="Edit list name"
                  >
                    <Pencil size={14} />
                  </button>
                )}
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
                      <li
                        key={item.id}
                        className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b border-zinc-800 group last:border-0"
                      >
                        <button
                          onClick={() => void toggleItem(item.id, !item.checked)}
                          className={cn(
                            'shrink-0 w-4 h-4 rounded border transition-colors flex items-center justify-center',
                            item.checked
                              ? 'bg-zinc-600 border-zinc-600'
                              : 'border-zinc-600 hover:border-zinc-400',
                          )}
                          aria-label={item.checked ? 'Uncheck' : 'Check'}
                        >
                          {item.checked && (
                            <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-zinc-200">
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
                        {editingItemId === item.id ? (
                          <input
                            ref={editInputRef}
                            value={editingItemText}
                            onChange={(event) => setEditingItemText(event.target.value)}
                            onBlur={() => void submitItemEdit(item.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void submitItemEdit(item.id)
                              }
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelEditingItem()
                              }
                            }}
                            className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-zinc-500"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => void toggleItem(item.id, !item.checked)}
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
                        {confirmingItemDeleteId === item.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void confirmDeleteItem(item.id)}
                              className="opacity-100 transition-opacity p-0.5 text-zinc-600 hover:text-red-400"
                              aria-label="Confirm delete item"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingItemDeleteId(null)}
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
                              onClick={() => startEditingItem(item.id, item.text)}
                              className="p-0.5 text-zinc-600 hover:text-zinc-300 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                              aria-label="Edit item"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingItemDeleteId(item.id)}
                              className="p-0.5 text-zinc-600 hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                              aria-label="Delete item"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {!detail.archived && (
                <form
                  onSubmit={handleAddItem}
                  className="px-3 sm:px-4 py-2.5 border-t border-zinc-800 flex items-center gap-2 shrink-0"
                >
                  <Plus size={14} className="text-zinc-600 shrink-0" />
                  <input
                    ref={addInputRef}
                    value={addText}
                    onChange={(event) => setAddText(event.target.value)}
                    placeholder="Add item…"
                    className="flex-1 bg-transparent text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none"
                  />
                  {addText.trim() && (
                    <button
                      type="submit"
                      className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
                    >
                      Add
                    </button>
                  )}
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TypeBadge({ type }: { type: ListType }) {
  const colors: Record<ListType, string> = {
    checklist: 'text-blue-400 bg-blue-400/10',
    grocery: 'text-green-400 bg-green-400/10',
    todo: 'text-purple-400 bg-purple-400/10',
  }
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', colors[type])}>
      {type}
    </span>
  )
}

function ListSidebarRow({
  list,
  selectedId,
  editingSidebarListId,
  sidebarListNameDraft,
  sidebarListNameInputRef,
  confirmingListDeleteId,
  onSelect,
  onDraftChange,
  onSubmitEdit,
  onCancelEdit,
  onStartEdit,
  onArchive,
  onAskDelete,
  onConfirmDelete,
}: {
  list: {
    id: string
    name: string
    list_type: ListType
    item_count: number
    archived: boolean
  }
  selectedId: string | null
  editingSidebarListId: string | null
  sidebarListNameDraft: string
  sidebarListNameInputRef: React.RefObject<HTMLInputElement | null>
  confirmingListDeleteId: string | null
  onSelect: (id: string) => Promise<void>
  onDraftChange: (value: string) => void
  onSubmitEdit: (listId: string) => Promise<void>
  onCancelEdit: () => void
  onStartEdit: (listId: string, name: string) => void
  onArchive: (id: string, archived: boolean) => Promise<void>
  onAskDelete: (listId: string | null) => void
  onConfirmDelete: (listId: string) => Promise<void>
}) {
  return (
    <div
      onClick={() => {
        if (!editingSidebarListId) void onSelect(list.id)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (editingSidebarListId) return
        if (event.key === 'Enter') void onSelect(list.id)
      }}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg border transition-colors group cursor-pointer',
        selectedId === list.id
          ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
          : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {editingSidebarListId === list.id ? (
          <input
            ref={sidebarListNameInputRef}
            value={sidebarListNameDraft}
            onChange={(event) => onDraftChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                void onSubmitEdit(list.id)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onCancelEdit()
              }
            }}
            className="min-w-0 flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-medium text-zinc-100 focus:outline-none focus:border-zinc-500"
          />
        ) : (
          <span className="text-sm font-medium truncate flex-1">{list.name}</span>
        )}
        <div className="flex items-center gap-1 shrink-0 text-zinc-500 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          {confirmingListDeleteId === list.id ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void onConfirmDelete(list.id)
                }}
                title="Confirm delete"
                className="p-0.5 text-zinc-500 hover:text-red-400"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onAskDelete(null)
                }}
                title="Cancel delete"
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <X size={13} />
              </button>
            </>
          ) : editingSidebarListId === list.id ? (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void onSubmitEdit(list.id)
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
                  onCancelEdit()
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
                  onStartEdit(list.id, list.name)
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
                  void onArchive(list.id, !list.archived)
                }}
                title={list.archived ? 'Unarchive' : 'Archive'}
                className="p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <Archive size={13} />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onAskDelete(list.id)
                }}
                title="Delete"
                className="p-0.5 text-zinc-500 hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <TypeBadge type={list.list_type} />
        <span className="text-xs text-zinc-600">
          {list.item_count} item{list.item_count !== 1 ? 's' : ''}
        </span>
        {list.archived && <span className="text-xs text-amber-600">archived</span>}
      </div>
    </div>
  )
}
