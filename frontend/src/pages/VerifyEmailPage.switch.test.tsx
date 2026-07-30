// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { VerifyEmailPage } from './VerifyEmailPage'

const verifyEmail = vi.fn()

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/verify-email${search}`]}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/" element={<p>Home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('VerifyEmailPage account switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyEmail.mockResolvedValue(undefined)
    useAuthStore.setState({ status: 'unauthenticated', user: null, verifyEmail })
  })

  afterEach(() => {
    useAuthStore.setState({ status: 'unauthenticated', user: null })
  })

  it('verifies immediately when nobody is signed in', async () => {
    renderAt('?token=abc')

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('abc'))
  })

  it('asks before swapping the session of a signed-in visitor', async () => {
    // Verifying signs you in as the link's account, so doing it silently changes who someone is.
    useAuthStore.setState({ status: 'authenticated', user: { email: 'me@example.com' } as never })

    renderAt('?token=abc')

    expect(await screen.findByRole('heading', { name: /switch accounts/i })).toBeVisible()
    expect(screen.getByText('me@example.com')).toBeVisible()
    expect(verifyEmail).not.toHaveBeenCalled()
  })

  it('verifies once the switch is confirmed', async () => {
    useAuthStore.setState({ status: 'authenticated', user: { email: 'me@example.com' } as never })

    renderAt('?token=abc')
    fireEvent.click(await screen.findByRole('button', { name: /continue/i }))

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith('abc'))
  })

  it('does not verify while auth is still resolving', async () => {
    // `loading` reads as "nobody is signed in" unless handled, which would race the session and
    // swap it before the prompt could appear.
    useAuthStore.setState({ status: 'loading', user: null })

    renderAt('?token=abc')

    await waitFor(() => expect(verifyEmail).not.toHaveBeenCalled())
  })
})
