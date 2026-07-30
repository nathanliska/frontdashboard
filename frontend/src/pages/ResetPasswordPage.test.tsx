// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCheckPasswordResetToken } from '../api/auth'
import { useAuthStore } from '../stores/auth'
import { ResetPasswordPage } from './ResetPasswordPage'

vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth')
  return { ...actual, apiCheckPasswordResetToken: vi.fn() }
})

const mockedCheck = vi.mocked(apiCheckPasswordResetToken)

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ status: 'unauthenticated', user: null })
  })

  it('says so before asking for a password when the link is dead', async () => {
    mockedCheck.mockResolvedValue(false)

    renderAt('?token=spent')

    expect(
      await screen.findByText(/expired, has already been used, or is not valid/i),
    ).toBeVisible()
    expect(screen.queryByLabelText(/new password/i)).toBeNull()
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  it('offers the form for a live link', async () => {
    mockedCheck.mockResolvedValue(true)

    renderAt('?token=live')

    expect(await screen.findByLabelText(/new password/i)).toBeVisible()
    expect(mockedCheck).toHaveBeenCalledWith('live')
  })

  it('warns that the link may not be for the signed-in account', async () => {
    // The reported confusion: opening someone else's reset link while signed in gave no hint that
    // the two were unrelated. The link's own owner stays unnamed — that would be an oracle.
    mockedCheck.mockResolvedValue(true)
    useAuthStore.setState({
      status: 'authenticated',
      user: { email: 'me@example.com' } as never,
    })

    renderAt('?token=live')

    expect(await screen.findByText(/you are signed in as/i)).toHaveTextContent('me@example.com')
  })

  it('does not call the API when the link carries no token', async () => {
    renderAt('')

    expect(await screen.findByText(/missing a token/i)).toBeVisible()
    await waitFor(() => expect(mockedCheck).not.toHaveBeenCalled())
  })
})
