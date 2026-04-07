/**
 * Lists store — manages the sidebar list of lists and the selected list's detail.
 *
 * SSE integration: handleSseEvent is registered in useSSE.ts and called whenever
 * a list.* event arrives. It refetches the list summary row and, if the affected
 * list is currently open, re-fetches the detail too.
 *
 * The `selectedId` / `detail` pair works like a cursor — selectedId is set
 * immediately (so the sidebar highlights the row), detail is null until loaded.
 * Components should show a spinner when selectedId is set but detail is null.
 */

import { create } from 'zustand'
import {
  type ListDetail,
  type ListItem,
  type ListSummary,
  type ListType,
  apiCreateItem,
  apiCreateList,
  apiDeleteItem,
  apiDeleteList,
  apiGetList,
  apiGetLists,
  apiUpdateItem,
  apiUpdateList,
} from '../api/lists'
import type { SseEvent } from '../hooks/useSSE'
import { useAuthStore } from './auth'
import { toast } from './toast'

const ITEM_COUNT_EVENT_TYPES = new Set(['list.item.created', 'list.item.deleted'])
const SELF_PATCHED_ITEM_EVENT_TYPES = new Set(['list.item.checked', 'list.item.updated'])
const LOCAL_ITEM_EVENT_TTL_MS = 5000
const recentLocalItemMutations = new Map<string, number>()
let inFlightListsLoad: { dashboardId: string | null; promise: Promise<void> } | null = null

type LoadListsOptions = {
  background?: boolean
}

type SelectListOptions = {
  background?: boolean
}

function markLocalItemMutation(itemId: string) {
  recentLocalItemMutations.set(itemId, Date.now())
}

function clearLocalItemMutation(itemId: string) {
  recentLocalItemMutations.delete(itemId)
}

function consumeRecentLocalItemMutation(itemId: string): boolean {
  const timestamp = recentLocalItemMutations.get(itemId)
  if (!timestamp) return false

  recentLocalItemMutations.delete(itemId)
  return Date.now() - timestamp < LOCAL_ITEM_EVENT_TTL_MS
}

interface ListsState {
  lists: ListSummary[]
  selectedId: string | null
  detail: ListDetail | null
  loading: boolean
  dashboardId: string | null
  loadLists: (dashboardId?: string | null, options?: LoadListsOptions) => Promise<void>
  clearSelection: () => void
  selectList: (id: string, options?: SelectListOptions) => Promise<void>
  createList: (name: string, listType: ListType, dashboardId: string) => Promise<void>
  updateListName: (id: string, name: string) => Promise<void>
  deleteList: (id: string) => Promise<void>
  archiveList: (id: string, archived: boolean) => Promise<void>
  addItem: (text: string) => Promise<void>
  updateItemText: (itemId: string, text: string) => Promise<void>
  toggleItem: (itemId: string, checked: boolean) => Promise<void>
  deleteItem: (itemId: string) => Promise<void>
  handleSseEvent: (event: SseEvent) => Promise<void>
}

export const useListsStore = create<ListsState>()((set, get) => ({
  lists: [],
  selectedId: null,
  detail: null,
  loading: false,
  dashboardId: null,

  async loadLists(dashboardId = null, options = {}) {
    if (inFlightListsLoad?.dashboardId === dashboardId) {
      return inFlightListsLoad.promise
    }

    const showLoading = !options.background
    set(showLoading ? { loading: true, dashboardId } : { dashboardId })

    const promise = (async () => {
      try {
        const lists = await apiGetLists(dashboardId)
        set((state) => ({
          lists,
          dashboardId,
          ...(showLoading ? { loading: false } : { loading: state.loading }),
        }))
      } catch {
        if (showLoading) {
          set({ loading: false })
          toast.error('Failed to load lists.')
        }
      } finally {
        if (inFlightListsLoad?.dashboardId === dashboardId) inFlightListsLoad = null
      }
    })()

    inFlightListsLoad = { dashboardId, promise }
    return promise
  },

  clearSelection() {
    set({ selectedId: null, detail: null })
  },

  async selectList(id, options = {}) {
    const showLoading = !options.background
    set(showLoading ? { selectedId: id, detail: null } : { selectedId: id })
    try {
      const detail = await apiGetList(id)
      set((s) => (s.selectedId === id ? { detail } : {}))
    } catch {
      // Ignore stale loads if the user has already selected a different list.
      if (get().selectedId !== id) return
      if (showLoading) {
        // Keep selectedId set (row stays highlighted) but detail stays null.
        // The detail panel renders a "could not load" message when selectedId is set + detail is null.
        toast.error('Failed to load list.')
      }
    }
  },

  async createList(name, listType, dashboardId) {
    // Re-throw on error so the form can surface backend validation messages
    const list = await apiCreateList({
      name,
      list_type: listType,
      dashboard_id: dashboardId,
    })
    set((s) => ({ lists: [...s.lists, list] }))
    // Auto-select so the detail panel opens immediately and addItem can work
    void get().selectList(list.id)
  },

  async updateListName(id, name) {
    try {
      const updated = await apiUpdateList(id, { name })
      set((s) => ({
        lists: s.lists.map((l) => (l.id === id ? updated : l)),
        detail:
          s.detail?.id === id
            ? { ...s.detail, name: updated.name, updated_at: updated.updated_at }
            : s.detail,
      }))
    } catch (err) {
      toast.error('Failed to rename list.')
      throw err instanceof Error ? err : new Error('Failed to rename list.')
    }
  },

  async deleteList(id) {
    try {
      await apiDeleteList(id)
      set((s) => ({
        lists: s.lists.filter((l) => l.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        detail: s.selectedId === id ? null : s.detail,
      }))
    } catch {
      toast.error('Failed to delete list.')
    }
  },

  async archiveList(id, archived) {
    try {
      const updated = await apiUpdateList(id, { archived })
      set((s) => ({
        lists: s.lists.map((l) => (l.id === id ? updated : l)),
        detail: s.detail?.id === id ? { ...s.detail, archived } : s.detail,
      }))
    } catch {
      toast.error('Failed to archive list.')
    }
  },

  async addItem(text) {
    const { selectedId } = get()
    if (!selectedId) return
    try {
      const item = await apiCreateItem(selectedId, text)
      set((s) => ({
        detail:
          s.detail?.id === selectedId
            ? { ...s.detail, items: [...s.detail.items, item], item_count: s.detail.item_count + 1 }
            : s.detail,
        lists: s.lists.map((l) =>
          l.id === selectedId ? { ...l, item_count: l.item_count + 1 } : l,
        ),
      }))
    } catch {
      toast.error('Failed to add item.')
    }
  },

  async updateItemText(itemId, text) {
    const { selectedId, detail } = get()
    if (!selectedId || !detail || detail.id !== selectedId) return
    if (!detail.items.some((item) => item.id === itemId)) return

    markLocalItemMutation(itemId)
    try {
      const item: ListItem = await apiUpdateItem(selectedId, itemId, { text })
      set((s) => ({
        detail:
          s.detail?.id === selectedId
            ? { ...s.detail, items: s.detail.items.map((i) => (i.id === itemId ? item : i)) }
            : s.detail,
      }))
    } catch (err) {
      clearLocalItemMutation(itemId)
      toast.error('Failed to rename item.')
      throw err instanceof Error ? err : new Error('Failed to rename item.')
    }
  },

  async toggleItem(itemId, checked) {
    const { selectedId, detail } = get()
    if (!selectedId || !detail || detail.id !== selectedId) return
    if (!detail.items.some((item) => item.id === itemId)) return
    markLocalItemMutation(itemId)
    try {
      const item: ListItem = await apiUpdateItem(selectedId, itemId, { checked })
      set((s) => ({
        detail:
          s.detail?.id === selectedId
            ? { ...s.detail, items: s.detail.items.map((i) => (i.id === itemId ? item : i)) }
            : s.detail,
      }))
    } catch {
      clearLocalItemMutation(itemId)
      toast.error('Failed to update item.')
    }
  },

  async deleteItem(itemId) {
    const { selectedId } = get()
    if (!selectedId) return
    try {
      await apiDeleteItem(selectedId, itemId)
      set((s) => ({
        detail:
          s.detail?.id === selectedId
            ? {
                ...s.detail,
                items: s.detail.items.filter((i) => i.id !== itemId),
                item_count: s.detail.item_count - 1,
              }
            : s.detail,
        lists: s.lists.map((l) =>
          l.id === selectedId ? { ...l, item_count: Math.max(0, l.item_count - 1) } : l,
        ),
      }))
    } catch {
      toast.error('Failed to delete item.')
    }
  },

  async handleSseEvent(event) {
    const { selectedId, dashboardId } = get()

    // Resync: full refetch of current view
    if (event.event_type === 'resync') {
      await get().loadLists(dashboardId, { background: true })
      if (selectedId) await get().selectList(selectedId, { background: true })
      return
    }

    // Ignore non-list events (membership, dashboard, etc.)
    if (!event.event_type.startsWith('list.')) return

    const isItemEvent = event.entity_type === 'list_item'
    const affectedListId = isItemEvent
      ? (event.payload.list_id as string | undefined)
      : event.entity_id
    const currentUserId = useAuthStore.getState().user?.id

    if (
      isItemEvent &&
      SELF_PATCHED_ITEM_EVENT_TYPES.has(event.event_type) &&
      event.actor_id === currentUserId &&
      consumeRecentLocalItemMutation(event.entity_id)
    ) {
      return
    }

    // Clear selection before reloading if the selected list was deleted
    if (event.event_type === 'list.deleted' && selectedId === affectedListId) {
      set({ selectedId: null, detail: null })
    }

    const shouldReloadLists = !isItemEvent || ITEM_COUNT_EVENT_TYPES.has(event.event_type)
    if (shouldReloadLists) {
      await get().loadLists(dashboardId, { background: true })
    }

    // Refresh open detail if the event affects the currently selected list
    const currentSelected = get().selectedId
    if (currentSelected && affectedListId === currentSelected) {
      await get().selectList(currentSelected, { background: true })
    }
  },
}))
