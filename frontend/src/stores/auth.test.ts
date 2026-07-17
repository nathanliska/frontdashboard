import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../api/auth'
import { useAuthStore } from './auth'

const { resetCalendarData } = vi.hoisted(() => ({
  resetCalendarData: vi.fn(),
}))

const { resetListData } = vi.hoisted(() => ({
  resetListData: vi.fn(),
}))

const {
  apiChangePassword,
  apiGetMe,
  apiLogin,
  apiLogout,
  apiRegister,
  apiVerifyEmail,
  apiUpdatePreferences,
  apiUpdateProfile,
} = vi.hoisted(() => ({
  apiChangePassword: vi.fn(),
  apiGetMe: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  apiVerifyEmail: vi.fn(),
  apiUpdatePreferences: vi.fn(),
  apiUpdateProfile: vi.fn(),
}))

const toastError = vi.hoisted(() => vi.fn())

const { tryRefreshMock } = vi.hoisted(() => ({
  tryRefreshMock: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../api/client', () => ({
  tryRefresh: tryRefreshMock,
}))

vi.mock('../api/auth', () => ({
  apiChangePassword,
  apiGetMe,
  apiLogin,
  apiLogout,
  apiRegister,
  apiVerifyEmail,
  apiUpdatePreferences,
  apiUpdateProfile,
}))

vi.mock('../resources/calendarData', () => ({
  resetCalendarData,
}))

vi.mock('../resources/listData', () => ({
  resetListData,
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
    tryRefreshMock.mockResolvedValue(true)

    await useAuthStore.getState().init()

    // Bootstrap must go through the shared tryRefresh — it is the only refresh
    // path that sends the X-CSRF-Token header and single-flights the request.
    // A hand-rolled fetch here would 403 against the backend CSRF guard.
    expect(tryRefreshMock).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(apiGetMe).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('falls back to unauthenticated when refresh does not recover the session', async () => {
    apiGetMe.mockResolvedValue(null)
    tryRefreshMock.mockResolvedValue(false)

    await useAuthStore.getState().init()

    expect(tryRefreshMock).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()

    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(resetCalendarData).toHaveBeenCalledTimes(1)
    expect(resetListData).toHaveBeenCalledTimes(1)
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
    expect(resetCalendarData).toHaveBeenCalledTimes(1)
    expect(resetListData).toHaveBeenCalledTimes(1)
  })
})
