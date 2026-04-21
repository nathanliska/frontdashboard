import { type FormEvent, useEffect, useState } from 'react'
import { apiGetLists, type ListSummary, type ListType } from '../../../api/lists'
import type { AddWidgetParams } from '../../../utils/dashboard/widgetCreationTypes'

export function AddWidgetListStep({
  dashboardId,
  existingListIds,
  isSharedDashboard,
  dashboardName,
  onAdd,
}: {
  dashboardId: string
  existingListIds: string[]
  isSharedDashboard: boolean
  dashboardName?: string
  onAdd: (params: AddWidgetParams) => Promise<void>
}) {
  const [availableLists, setAvailableLists] = useState<ListSummary[]>([])
  const [loadingLists, setLoadingLists] = useState(true)
  const existingListIdKey = existingListIds.join(':')

  useEffect(() => {
    let cancelled = false
    const existingIdSet = new Set(existingListIdKey ? existingListIdKey.split(':') : [])

    void apiGetLists(dashboardId)
      .then((lists) => {
        if (cancelled) return
        setAvailableLists(lists.filter((list) => !existingIdSet.has(list.id)))
      })
      .catch(() => {
        if (cancelled) return
        setAvailableLists([])
      })
      .finally(() => {
        if (!cancelled) setLoadingLists(false)
      })

    return () => {
      cancelled = true
    }
  }, [dashboardId, existingListIdKey])

  async function handleCreateList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const name = String(formData.get('list-name') ?? '').trim()
    const listType = String(formData.get('list-type') ?? 'checklist') as ListType

    await onAdd({
      widget_type: 'list',
      resource_type: 'list',
      config: {
        name: name || 'Untitled List',
        list_type: listType,
      },
    })
  }

  return (
    <div className="p-3 max-h-72 overflow-y-auto space-y-3">
      {isSharedDashboard && (
        <div className="mx-1 mb-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <p className="text-xs text-zinc-400">
            This list will belong to {dashboardName ?? 'this dashboard'}, so everyone with access
            there will see the same items.
          </p>
        </div>
      )}
      <div className="space-y-2 px-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Existing lists</p>
        {loadingLists ? (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-500">
            <div className="h-3 w-3 animate-spin rounded-full border border-zinc-700 border-t-zinc-500" />
            Loading lists...
          </div>
        ) : availableLists.length > 0 ? (
          <div className="space-y-1">
            {availableLists.map((list) => (
              <button
                key={list.id}
                type="button"
                onClick={() =>
                  void onAdd({
                    widget_type: 'list',
                    resource_type: 'list',
                    resource_id: list.id,
                    config: {
                      list_name: list.name,
                      list_type: list.list_type,
                    },
                  })
                }
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900"
              >
                <p className="text-sm text-zinc-200">{list.name}</p>
                <p className="text-xs text-zinc-500 mt-0.5 capitalize">{list.list_type}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-xs text-zinc-500">
            No unplaced lists on this dashboard yet.
          </p>
        )}
      </div>
      <div className="border-t border-zinc-800/80 pt-3 space-y-2 px-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Create new</p>
      </div>
      <form onSubmit={(event) => void handleCreateList(event)} className="space-y-2 px-1">
        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">List name</span>
          <input
            name="list-name"
            placeholder="Groceries"
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">List type</span>
          <select
            name="list-type"
            defaultValue="checklist"
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
          >
            <option value="checklist">Checklist</option>
            <option value="grocery">Grocery</option>
            <option value="todo">Todo</option>
          </select>
        </label>
        <button
          type="submit"
          className="w-full flex flex-col items-start px-4 py-3 rounded-lg hover:bg-zinc-800 transition-colors text-left"
        >
          <span className="text-sm font-medium text-zinc-200">Create list widget</span>
          <span className="text-xs text-zinc-500 mt-0.5">
            {isSharedDashboard
              ? `Creates one shared list for ${dashboardName ?? 'this dashboard'}.`
              : 'Creates a new list for this dashboard.'}
          </span>
        </button>
      </form>
    </div>
  )
}
