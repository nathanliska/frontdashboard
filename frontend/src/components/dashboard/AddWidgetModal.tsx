import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { type ListType, type ListSummary, apiGetLists } from '../../api/lists'

export interface AddWidgetParams {
  widget_type: string
  config?: Record<string, unknown>
  resource_type?: string | null
  resource_id?: string | null
}

const WIDGET_TYPES = [
  {
    type: 'calendar',
    label: 'Calendar',
    description: 'Day, week, or month view',
  },
  {
    type: 'list',
    label: 'List',
    description: 'Checklist, grocery list, or to-do list',
  },
  {
    type: 'clock',
    label: 'Clock',
    description: 'Current time and date',
  },
] as const

export function AddWidgetModal({
  onAdd,
  onClose,
  dashboardId,
  existingListIds,
  isSharedDashboard,
  dashboardName,
}: {
  onAdd: (params: AddWidgetParams) => Promise<void>
  onClose: () => void
  dashboardId: string
  existingListIds: string[]
  isSharedDashboard: boolean
  dashboardName?: string
}) {
  const [step, setStep] = useState<'pick-type' | 'pick-list' | 'pick-calendar'>('pick-type')
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (step !== 'pick-type') setStep('pick-type')
        else onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [step, onClose])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose()
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-sm mx-4">
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-800">
          {step !== 'pick-type' && (
            <button
              onClick={() => setStep('pick-type')}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <h2 className="flex-1 text-sm font-semibold text-zinc-100">
            {step === 'pick-type'
              ? 'Add widget'
              : step === 'pick-list'
                ? 'Add a list'
                : 'Choose a calendar view'}
          </h2>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300 transition-colors">
            <X size={16} />
          </button>
        </div>

        {step === 'pick-type' ? (
          <PickTypeStep
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onPickList={() => setStep('pick-list')}
            onPickCalendar={() => setStep('pick-calendar')}
            onAdd={onAdd}
          />
        ) : step === 'pick-list' ? (
          <PickListStep
            dashboardId={dashboardId}
            existingListIds={existingListIds}
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onAdd={onAdd}
          />
        ) : (
          <PickCalendarStep
            isSharedDashboard={isSharedDashboard}
            dashboardName={dashboardName}
            onAdd={onAdd}
          />
        )}
      </div>
    </div>
  )
}

function PickTypeStep({
  isSharedDashboard,
  dashboardName,
  onPickList,
  onPickCalendar,
  onAdd,
}: {
  isSharedDashboard: boolean
  dashboardName?: string
  onPickList: () => void
  onPickCalendar: () => void
  onAdd: (params: AddWidgetParams) => Promise<void>
}) {
  return (
    <div className="p-3 space-y-1">
      {isSharedDashboard && (
        <div className="px-4 py-3 rounded-lg border border-zinc-800 bg-zinc-950/60">
          <p className="text-sm text-zinc-200">Shared dashboard</p>
          <p className="text-xs text-zinc-500 mt-1">
            Everyone with access to {dashboardName ?? 'this dashboard'} should see the same widget
            content here.
          </p>
        </div>
      )}
      {WIDGET_TYPES.map(({ type, label, description }) => {
        const effectiveDescription =
          type === 'calendar'
            ? isSharedDashboard
              ? 'Show events visible to everyone with access to this dashboard'
              : 'Your own accessible events'
            : type === 'clock' && isSharedDashboard
              ? 'Uses one shared timezone for everyone'
              : description
        return (
          <button
            key={type}
            onClick={() => {
              if (type === 'list') {
                onPickList()
              } else if (type === 'calendar') {
                onPickCalendar()
              } else if (type === 'clock') {
                void onAdd({
                  widget_type: type,
                  config: isSharedDashboard
                    ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
                    : {},
                })
              } else {
                void onAdd({ widget_type: type })
              }
            }}
            className="w-full flex flex-col items-start px-4 py-3 rounded-lg text-left transition-colors hover:bg-zinc-800"
          >
            <span className="text-sm font-medium text-zinc-200">{label}</span>
            <span className="text-xs text-zinc-500 mt-0.5">{effectiveDescription}</span>
          </button>
        )
      })}
    </div>
  )
}

function PickCalendarStep({
  isSharedDashboard,
  dashboardName,
  onAdd,
}: {
  isSharedDashboard: boolean
  dashboardName?: string
  onAdd: (params: AddWidgetParams) => Promise<void>
}) {
  const [view, setView] = useState<'day' | 'week' | 'month'>('month')

  return (
    <div className="p-3 max-h-72 overflow-y-auto space-y-1">
      <div className="px-1 pb-2">
        <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500 mb-2">View</p>
        <div className="grid grid-cols-3 gap-1">
          {(['day', 'week', 'month'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setView(value)}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                view === value
                  ? 'bg-zinc-100 text-zinc-950'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {value[0].toUpperCase()}
              {value.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() =>
          void onAdd({
            widget_type: 'calendar',
            config: {
              view,
            },
          })
        }
        className="w-full flex flex-col items-start px-4 py-3 rounded-lg hover:bg-zinc-800 transition-colors text-left"
      >
        <span className="text-sm font-medium text-zinc-200">Calendar</span>
        <span className="text-xs text-zinc-500 mt-0.5">
          {isSharedDashboard
            ? `Everyone on ${dashboardName ?? 'this dashboard'} will see the same events here.`
            : 'Show day, week, or month from this dashboard.'}
        </span>
      </button>
    </div>
  )
}

function PickListStep({
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
  const [name, setName] = useState('')
  const [listType, setListType] = useState<ListType>('checklist')
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
      <div className="space-y-2 px-1">
        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">List name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Groceries"
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="text-zinc-400">List type</span>
          <select
            value={listType}
            onChange={(event) => setListType(event.target.value as ListType)}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
          >
            <option value="checklist">Checklist</option>
            <option value="grocery">Grocery</option>
            <option value="todo">Todo</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={() =>
          void onAdd({
            widget_type: 'list',
            resource_type: 'list',
            config: {
              name: name.trim() || 'Untitled List',
              list_type: listType,
            },
          })
        }
        className="w-full flex flex-col items-start px-4 py-3 rounded-lg hover:bg-zinc-800 transition-colors text-left"
      >
        <span className="text-sm font-medium text-zinc-200">Create list widget</span>
        <span className="text-xs text-zinc-500 mt-0.5">
          {isSharedDashboard
            ? `Creates one shared list for ${dashboardName ?? 'this dashboard'}.`
            : 'Creates a new list for this dashboard.'}
        </span>
      </button>
    </div>
  )
}
