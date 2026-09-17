// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/http'
import { useAuthStore } from '../stores/auth'
import { signIn } from '../test/signIn'
import { ProfilePage } from './ProfilePage'

const { apiDeleteAccount } = vi.hoisted(() => ({ apiDeleteAccount: vi.fn() }))
vi.mock('../api/auth', async () => {
  const actual = await vi.importActual<typeof import('../api/auth')>('../api/auth')
  return { ...actual, apiDeleteAccount }
})

function submitDeletion(password: string) {
  render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
  fireEvent.change(screen.getByLabelText(/confirm your password/i), { target: { value: password } })
  fireEvent.submit(
    screen.getByLabelText(/confirm your password/i).closest('form') as HTMLFormElement,
  )
}

describe('deleting an account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signIn()
  })

  it('attaches a refusal to the password field and stays signed in', async () => {
    apiDeleteAccount.mockRejectedValue(
      new ApiError('Hand over or delete the dashboards you share first: Household', 409),
    )

    submitDeletion('current-passphrase-1')

    await waitFor(() =>
      expect(screen.getByLabelText(/confirm your password/i)).toHaveAccessibleDescription(
        /Household/,
      ),
    )
    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('signs out locally once the server has deleted the account', async () => {
    apiDeleteAccount.mockResolvedValue(undefined)

    submitDeletion('current-passphrase-1')

    await waitFor(() => expect(apiDeleteAccount).toHaveBeenCalledWith('current-passphrase-1'))
    await waitFor(() => expect(useAuthStore.getState().status).toBe('unauthenticated'))
  })
})
