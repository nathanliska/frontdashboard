/**
 * Dashboard store — the listing page's summaries and the editor's active dashboard.
 *
 * Both live here because they share the same data. Layout saves carry the version they loaded; a
 * 409 is rebased onto the server's layout and retried once, and only a second one sets `conflict`
 * for the UI to offer a reload. Actions never throw: errors go to the global toast store.
 */
import { create } from 'zustand'
import { createActiveSlice, resetActive } from './dashboard/active'
import { createCollectionSlice, resetCollection } from './dashboard/collection'
import { createEventsSlice, resetEvents } from './dashboard/events'
import type { DashboardState } from './dashboard/state'
import { createTrashSlice, resetTrash } from './dashboard/trash'
import { bumpSessionGeneration } from './sessionGeneration'

export type { DashboardState }

export const useDashboardStore = create<DashboardState>()((set, get) => ({
  ...createCollectionSlice(set, get),
  ...createTrashSlice(set, get),
  ...createActiveSlice(set, get),
  ...createEventsSlice(set, get),
}))

export function resetDashboardData(): void {
  bumpSessionGeneration()
  resetEvents()
  resetActive()
  resetCollection()
  resetTrash()
  useDashboardStore.setState({
    summaries: [],
    summariesLoaded: false,
    summariesLoading: false,
    trash: [],
    trashLoaded: false,
    dashboard: null,
    loading: false,
    loadError: false,
    conflict: false,
  })
}
