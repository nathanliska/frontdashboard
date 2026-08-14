// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http'
import { useAuthStore } from '../stores/auth'
import { ProfilePage } from './ProfilePage'

const { apiChangePassword } = vi.hoisted(() => ({ apiChangePassword: vi.fn() }))
vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth')
  return { ...actual, apiChangePassword }
})

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('../stores/toast', async () =>
  (await import('../test/toast')).toastMock({ error: toastError }),
)

function submitPasswordChange(current: string, next: string) {
  render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /change/i }))
  fireEvent.change(screen.getByLabelText(/current password/i), { target: { value: current } })
  fireEvent.change(screen.getByLabelText(/^new password/i), { target: { value: next } })
  fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: next } })
  fireEvent.submit(screen.getByLabelText(/current password/i).closest('form') as HTMLFormElement)
}

describe('changing a password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({
      status: 'authenticated',
      user: { id: 'u1', email: 'a@example.com', display_name: 'A', preferences: {} },
    } as never)
  })

  it('attaches a rejected new password to the new-password field, not a toast', async () => {
    apiChangePassword.mockRejectedValue(
      new ApiError('That password appears on public lists of breached passwords.', 422),
    )

    submitPasswordChange('current-passphrase-1', 'password123')

    // The field, not a toast: a toast carries no association to the input that caused it, so a
    // screen reader on that control never reaches the reason it was refused.
    await waitFor(() =>
      expect(screen.getByLabelText(/^new password/i)).toHaveAccessibleDescription(
        /breached passwords/i,
      ),
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('attaches a wrong current password to the current-password field', async () => {
    apiChangePassword.mockRejectedValue(new ApiError('Current password is incorrect', 403))

    submitPasswordChange('wrong-passphrase-1', 'a-strong-passphrase-2')

    await waitFor(() =>
      expect(screen.getByLabelText(/current password/i)).toHaveAccessibleDescription(
        /current password is incorrect/i,
      ),
    )
    expect(toastError).not.toHaveBeenCalled()
  })
})
