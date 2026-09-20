// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http'
import { useAuthStore } from '../stores/auth'
import { signIn } from '../test/signIn'
import { ConfirmEmailChangePage } from './ConfirmEmailChangePage'

const { apiConfirmEmailChange, apiGetMe } = vi.hoisted(() => ({
  apiConfirmEmailChange: vi.fn(),
  apiGetMe: vi.fn(),
}))
vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth')
  return { ...actual, apiConfirmEmailChange, apiGetMe }
})

function open(search: string) {
  render(
    <MemoryRouter initialEntries={[`/confirm-email-change${search}`]}>
      <ConfirmEmailChangePage />
    </MemoryRouter>,
  )
}

describe('the page a change-of-email link opens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ status: 'unauthenticated', user: null })
  })

  it('spends the link only on a click, never on load', async () => {
    apiConfirmEmailChange.mockResolvedValue(undefined)
    open('?token=abc')
    expect(apiConfirmEmailChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))

    await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent(/email changed/i))
    expect(apiConfirmEmailChange).toHaveBeenCalledWith('abc')
    // Signed out, so there is no profile to go back to and nothing to re-read.
    expect(screen.getByRole('link')).toHaveTextContent(/sign in/i)
    expect(apiGetMe).not.toHaveBeenCalled()
  })

  it('re-reads the address when the confirming tab is signed in', async () => {
    signIn()
    const user = useAuthStore.getState().user
    apiConfirmEmailChange.mockResolvedValue(undefined)
    apiGetMe.mockResolvedValue({ ...user, email: 'new@example.com' })
    open('?token=abc')

    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))

    await waitFor(() => expect(useAuthStore.getState().user?.email).toBe('new@example.com'))
    expect(screen.getByRole('link')).toHaveTextContent(/profile/i)
  })

  it('still reports success when only the re-read of the address fails', async () => {
    signIn()
    apiConfirmEmailChange.mockResolvedValue(undefined)
    apiGetMe.mockRejectedValue(new TypeError('Failed to fetch'))
    open('?token=abc')

    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))

    // The link is spent; an error here would send the person back to a button that can only 400.
    await waitFor(() => expect(screen.getByRole('heading')).toHaveTextContent(/email changed/i))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says a dead link is dead and leaves the button to try again', async () => {
    apiConfirmEmailChange.mockRejectedValue(
      new ApiError('Invalid or expired confirmation link', 400),
    )
    open('?token=abc')

    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid or expired/i))
    expect(screen.getByRole('button', { name: /confirm email/i })).toBeEnabled()
  })

  it.each([
    ['a rate limit', new ApiError('Failed to confirm the new email', 429), /too many attempts/i],
    ['a dropped connection', new TypeError('Failed to fetch'), /check your connection/i],
    ['a server fault', new ApiError('Internal Server Error', 500), /try again in a moment/i],
  ])('words %s itself rather than echoing the error', async (_case, failure, message) => {
    apiConfirmEmailChange.mockRejectedValue(failure)
    open('?token=abc')

    fireEvent.click(screen.getByRole('button', { name: /confirm email/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message))
    expect(screen.getByRole('alert')).not.toHaveTextContent(/failed to/i)
  })

  it('disables the button for a link with no token', () => {
    open('')
    expect(screen.getByRole('button', { name: /confirm email/i })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/i)
  })
})
