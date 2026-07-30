// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import {
  createMockAuthState,
  mockUseAuthStore,
  resetMockAuthStore,
  setMockAuthState,
} from './test/auth-store'

vi.mock('./stores/auth', () => ({
  useAuthStore: (selector: (state: ReturnType<typeof createMockAuthState>) => unknown) =>
    mockUseAuthStore(selector),
}))

describe('unknown routes', () => {
  beforeEach(() => {
    setMockAuthState(createMockAuthState({ status: 'unauthenticated' }))
    window.history.pushState({}, '', '/reset-passwrd?token=abc')
  })

  afterEach(() => {
    resetMockAuthStore()
  })

  // The real route table — NotFoundPage's own tests declare their own <Routes> and would pass even
  // if the catch-all still redirected. The URL assertion is the half that catches that.
  it('renders the not-found page and keeps the address the visitor typed', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument()
    expect(screen.getByText('/reset-passwrd')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/reset-passwrd')
  })
})
