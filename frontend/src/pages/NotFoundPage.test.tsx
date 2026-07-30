// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { NotFoundPage } from './NotFoundPage'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NotFoundPage', () => {
  beforeEach(() => {
    useAuthStore.setState({ status: 'unauthenticated', user: null })
  })

  it('names the path that did not match', () => {
    renderAt('/reset-passwrd')

    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument()
    expect(screen.getByText('/reset-passwrd')).toBeInTheDocument()
  })

  it('sends a signed-out visitor to sign in', () => {
    renderAt('/nope')

    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/login')
  })

  it('offers no destination until auth resolves', () => {
    // Rendering during `loading` would offer "Go to sign in" to someone signed in, then swap it.
    useAuthStore.setState({ status: 'loading' })

    renderAt('/nope')

    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('sends a signed-in visitor somewhere they can actually use', () => {
    // Why it is conditional: /login is a dead end with a session, /dashboards bounces without one.
    useAuthStore.setState({ status: 'authenticated' })

    renderAt('/nope')

    expect(screen.getByRole('link', { name: /back to dashboards/i })).toHaveAttribute(
      'href',
      '/dashboards',
    )
  })
})
