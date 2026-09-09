// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMockAuthState,
  mockUseAuthStore,
  resetMockAuthStore,
  setMockAuthState,
} from '../../test/auth-store'
import { RequireAuth } from './RequireAuth'

vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (state: ReturnType<typeof createMockAuthState>) => unknown) =>
    mockUseAuthStore(selector),
}))

function renderRequireAuth() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>Private content</div>} />
        </Route>
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  afterEach(() => {
    resetMockAuthStore()
  })

  it('shows a loading status while auth is initializing', () => {
    setMockAuthState(createMockAuthState({ status: 'loading' }))

    renderRequireAuth()

    expect(
      screen.getByRole('status', {
        name: 'Loading authentication',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Private content')).not.toBeInTheDocument()
  })

  it('offers a retry instead of the login page when the server could not be reached', () => {
    const init = vi.fn()
    setMockAuthState(createMockAuthState({ status: 'unreachable', init }))

    renderRequireAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(init).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Login page')).not.toBeInTheDocument()
  })

  it('redirects unauthenticated users to login', () => {
    setMockAuthState(createMockAuthState({ status: 'unauthenticated' }))

    renderRequireAuth()

    expect(screen.getByText('Login page')).toBeInTheDocument()
    expect(screen.queryByText('Private content')).not.toBeInTheDocument()
  })

  it('renders protected content for authenticated users', () => {
    setMockAuthState(createMockAuthState({ status: 'authenticated' }))

    renderRequireAuth()

    expect(screen.getByText('Private content')).toBeInTheDocument()
  })
})
