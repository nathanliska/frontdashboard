// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/auth'
import { useAuthStore } from '../stores/auth'
import { RESEND_COOLDOWN_SECONDS, VerifyEmailPage } from './VerifyEmailPage'

const resend = vi.hoisted(() => vi.fn())
vi.mock('../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth')>()),
  apiResendVerification: resend,
}))

const verifyEmail = vi.fn()

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/verify-email${search}`]}>
      <VerifyEmailPage />
    </MemoryRouter>,
  )
}

describe('VerifyEmailPage resend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resend.mockResolvedValue(undefined)
    useAuthStore.setState({ status: 'unauthenticated', user: null, verifyEmail })
  })

  afterEach(() => {
    vi.useRealTimers()
    useAuthStore.setState({ status: 'unauthenticated', user: null })
  })

  it('sends to the address it already knows, then waits out the cooldown', async () => {
    vi.useFakeTimers()
    renderAt('?email=new%40example.com')
    // Signing up already named the address; a second field would only invite a typo.
    expect(screen.queryByLabelText('Email')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send another' }))
    })

    expect(resend).toHaveBeenCalledWith('new@example.com')
    expect(screen.getByText(/a link is on its way/i)).toBeVisible()
    const control = screen.getByRole('button', { name: /send another in/i })
    expect(control).toBeDisabled()

    // One second at a time: each tick schedules the next only once React has rendered it.
    const tick = () =>
      act(async () => {
        vi.advanceTimersByTime(1000)
      })
    for (let i = 1; i < RESEND_COOLDOWN_SECONDS; i++) await tick()
    expect(screen.getByRole('button', { name: 'Send another in 1s' })).toBeDisabled()
    await tick()
    expect(screen.getByRole('button', { name: 'Send another' })).toBeEnabled()
  })

  it('asks for the address when the page was opened without one', () => {
    renderAt('')

    expect(screen.getByLabelText('Email')).toBeVisible()
  })

  it('sends an already-verified visitor to sign in instead of offering another link', async () => {
    verifyEmail.mockRejectedValue(new ApiError('Email already verified. Please sign in.', 409))

    renderAt('?token=abc')

    expect(await screen.findByText(/your email is already verified/i)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /send another/i })).toBeNull()
    expect(screen.queryByText(/check your inbox/i)).toBeNull()
  })
})
