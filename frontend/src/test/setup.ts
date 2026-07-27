import '@testing-library/jest-dom'
import { afterEach } from 'vitest'
import * as toastStore from '../stores/toast'

/**
 * Cancel any auto-dismiss timers a test armed.
 *
 * Most test files don't mock `stores/toast`, so anything that surfaces an error arms a real 4s
 * timeout and then the file finishes in milliseconds. Vitest reuses a worker across files, so
 * those orphaned closures pile up holding the store — and the module graph behind it — alive.
 *
 * Optional call on purpose: in the files that *do* mock the module this resolves to the mock,
 * which has no reset helper and needs none, because a mocked toast never arms a timer.
 */
afterEach(() => {
  toastStore.__resetToastStoreForTests?.()
})
