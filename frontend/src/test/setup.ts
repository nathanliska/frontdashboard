import '@testing-library/jest-dom'
import { afterEach } from 'vitest'
import * as apiClient from '../api/client'
import * as resetRegistry from '../resources/resetRegistry'
import * as toastStore from '../stores/toast'
import * as dashboardMutation from '../utils/dashboard/dashboardMutation'
import * as listMutation from '../utils/lists/listMutation'

/**
 * Cancel what a test armed and drop what it cached.
 *
 * Vitest reuses a worker across files, so an uncleared timeout keeps its closure — and the store
 * and module graph behind it — alive for every file that follows. `resetAllResourceData` covers
 * each cache that registered itself, so a new one needs nothing here.
 *
 * Every call is optional on purpose: in the files that mock one of these modules this resolves to
 * the mock, which has no reset helper and needs none.
 */
afterEach(() => {
  toastStore.__resetToastStoreForTests?.()
  apiClient.__resetApiClientForTests?.()
  resetRegistry.resetAllResourceData?.()
  dashboardMutation.__resetPendingDashboardMutationsForTests?.()
  listMutation.__resetPendingListMutationsForTests?.()
})
