// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/http'
import { EmailChangeRow } from './EmailChangeRow'

const { apiRequestEmailChange } = vi.hoisted(() => ({ apiRequestEmailChange: vi.fn() }))
vi.mock('../../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth')>('../../api/auth')
  return { ...actual, apiRequestEmailChange }
})

function submit(newEmail: string, password: string) {
  render(<EmailChangeRow email="me@example.com" />)
  fireEvent.click(screen.getByRole('button', { name: /^change email$/i }))
  fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: newEmail } })
  fireEvent.change(screen.getByLabelText(/confirm your password/i), { target: { value: password } })
  fireEvent.submit(screen.getByLabelText(/new email/i).closest('form') as HTMLFormElement)
}

describe('asking to change the account email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says to check the new address without claiming it was free, and keeps the old one shown', async () => {
    apiRequestEmailChange.mockResolvedValue(undefined)

    submit('new@example.com', 'current-passphrase-1')

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/if new@example\.com can be used/i),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/stays me@example\.com/i)
    expect(apiRequestEmailChange).toHaveBeenCalledWith('new@example.com', 'current-passphrase-1')
    expect(screen.queryByLabelText(/new email/i)).toBeNull()
  })

  it('attaches a wrong password to the password field and keeps the form open', async () => {
    apiRequestEmailChange.mockRejectedValue(new ApiError('Password is incorrect', 403))

    submit('new@example.com', 'wrong')

    await waitFor(() =>
      expect(screen.getByLabelText(/confirm your password/i)).toHaveAccessibleDescription(
        /incorrect/i,
      ),
    )
    expect(screen.getByLabelText(/new email/i)).not.toHaveAccessibleDescription(/incorrect/i)
  })

  it.each([
    ['an invalid address', 422, /new email/i, /valid email address/i],
    ['a rate limit', 429, null, /too many attempts/i],
    ['a dropped connection', null, null, /check your connection/i],
    ['a server fault', 500, null, /try again in a moment/i],
  ])('words %s itself and puts it where it belongs', async (_case, status, field, message) => {
    // A 422's detail is a list and a 429 has none, so neither can be echoed back as a sentence.
    apiRequestEmailChange.mockRejectedValue(
      status ? new ApiError('[object Object]', status) : new TypeError('Failed to fetch'),
    )

    submit('a@b', 'current-passphrase-1')

    if (field)
      await waitFor(() => expect(screen.getByLabelText(field)).toHaveAccessibleDescription(message))
    else await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message))
    expect(document.body).not.toHaveTextContent('[object Object]')
  })

  it('drops the pending notice once the address shown is the one asked for', async () => {
    apiRequestEmailChange.mockResolvedValue(undefined)
    const { rerender } = render(<EmailChangeRow email="me@example.com" />)
    fireEvent.click(screen.getByRole('button', { name: /^change email$/i }))
    fireEvent.change(screen.getByLabelText(/new email/i), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByLabelText(/confirm your password/i), { target: { value: 'pw' } })
    fireEvent.submit(screen.getByLabelText(/new email/i).closest('form') as HTMLFormElement)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/can be used/i))
    // Focus goes back to the toggle, not to the body the unmounted submit button would leave it on.
    expect(screen.getByRole('button', { name: /^change email$/i })).toHaveFocus()

    rerender(<EmailChangeRow email="new@example.com" />)

    expect(screen.getByRole('status')).not.toHaveTextContent(/can be used/i)
  })

  it('refuses the current address without asking the server', () => {
    submit('ME@example.com', 'current-passphrase-1')

    expect(screen.getByLabelText(/new email/i)).toHaveAccessibleDescription(/already your email/i)
    expect(apiRequestEmailChange).not.toHaveBeenCalled()
  })
})
