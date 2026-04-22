// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import {
  createMockAuthState,
  mockUseAuthStore,
  resetMockAuthStore,
  setMockAuthState,
} from './test/auth-store'

const init = vi.fn()

vi.mock('./stores/auth', () => ({
  useAuthStore: (selector: (state: ReturnType<typeof createMockAuthState>) => unknown) =>
    mockUseAuthStore(selector),
}))

describe('App', () => {
  beforeEach(() => {
    init.mockReset()
    init.mockResolvedValue(undefined)
    window.history.pushState({}, '', '/login')

    const authState = createMockAuthState({
      status: 'unauthenticated',
      init,
    })

    setMockAuthState(authState)
  })

  afterEach(() => {
    resetMockAuthStore()
    window.history.pushState({}, '', '/')
  })

  it('renders the login route and kicks off auth initialization', async () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: 'FrontDashboard' })).toBeInTheDocument()
    await waitFor(() => {
      expect(init).toHaveBeenCalledTimes(1)
    })
  })
})
