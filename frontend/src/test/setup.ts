import '@testing-library/jest-dom'
import { afterEach } from 'vitest'
import * as apiClient from '../api/client'
import * as resetRegistry from '../resources/resetRegistry'
import * as connectionStore from '../stores/connection'
import * as toastStore from '../stores/toast'
import * as loadOptions from '../utils/dashboard/loadOptions'

// jsdom implements neither scroll API, and this setup also runs for node-environment files
// where `Element` is undefined. Scrolling is armed inside a requestAnimationFrame, so a missing
// one throws *after* the test that armed it, failing whichever file runs next.
// jsdom implements no ResizeObserver either, and `useContainerSize` constructs one unconditionally.
// Inert by default so a widget renders at its initial size; a file needing to drive a resize
// installs its own capturing stub over this one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
} as unknown as typeof ResizeObserver

if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.scrollTo ??= () => {}
}

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
  connectionStore.__resetConnectionStoreForTests?.()
  resetRegistry.resetAllResourceData?.()
  loadOptions.resetDashboardRequests?.()
})
