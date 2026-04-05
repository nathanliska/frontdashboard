import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../api/auth'
import { useAuthStore } from './auth'

const {
  apiChangePassword,
  apiGetMe,
  apiLogin,
  apiLogout,
  apiRegister,
  apiUpdatePreferences,
  apiUpdateProfile,
} = vi.hoisted(() => ({
  apiChangePassword: vi.fn(),
  apiGetMe: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  apiUpdatePreferences: vi.fn(),
  apiUpdateProfile: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

vi.mock('../api/auth', () => ({
  apiChangePassword,
  apiGetMe,
  apiLogin,
  apiLogout,
  apiRegister,
  apiUpdatePreferences,
  apiUpdateProfile,
}))

vi.mock('./toast', () => ({
  toast: {
    error: toastError,
  },
}))

const user: User = {
  id: 'user-1',
  email: 'user@example.com',
  display_name: 'Example User',
  preferences: {},
}

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    useAuthStore.setState({ status: 'loading', user: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates immediately when the current session is valid', async () => {
    apiGetMe.mockResolvedValue(user)

    await useAuthStore.getState().init()

    expect(apiGetMe).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().status).toBe('authenticated')
    expect(useAuthStore.getState().user).toEqual(user)
  })

  it('refreshes and retries when the current access token is stale', async () => {
    apiGetMe.mockResolvedValueOnce(null).mockResolvedValueOnce(user)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
    } as Response)

    await useAuthStore.getState().init()

    expect(fetch).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    expect(apiGetMe).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('falls back to unauthenticated when refresh does not recover the session', async () => {
    apiGetMe.mockResolvedValue(null)
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
    } as Response)

    await useAuthStore.getState().init()

    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('updates auth state on login and logout', async () => {
    apiLogin.mockResolvedValue(user)
    apiLogout.mockResolvedValue(undefined)

    await useAuthStore.getState().login('user@example.com', 'password123')
    expect(useAuthStore.getState().status).toBe('authenticated')
    expect(useAuthStore.getState().user).toEqual(user)

    await useAuthStore.getState().logout()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
  })
})
