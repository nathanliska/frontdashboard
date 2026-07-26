import { type Mock, vi } from 'vitest'

type ToastMethod = 'error' | 'success' | 'info'

/**
 * The toast store's imperative surface, stubbed.
 *
 * Non-component code reaches for `toast.*` directly, so almost every resource and store test has
 * to mock it. Defining the surface once means adding a method to the store doesn't mean editing
 * eight test files. Pass `overrides` to supply a spy the test asserts on — it must come from
 * `vi.hoisted`, since `vi.mock` factories are hoisted above the module body:
 *
 *     const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
 *     vi.mock('./toast', async () => (await import('../test/toast')).toastMock({ error: toastError }))
 */
export function toastMock(overrides: Partial<Record<ToastMethod, Mock>> = {}) {
  return {
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      ...overrides,
    },
  }
}
