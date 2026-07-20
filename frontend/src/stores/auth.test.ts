import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../api/auth'
import type { RefreshOutcome } from '../api/client'
import { useAuthStore } from './auth'
import { confirm } from './confirm'
import { bumpSessionGeneration } from './sessionGeneration'

const { resetCalendarData } = vi.hoisted(() => ({
  resetCalendarData: vi.fn(),
}))

const { resetListData } = vi.hoisted(() => ({
  resetListData: vi.fn(),
}))

const { resetDashboardData } = vi.hoisted(() => ({ resetDashboardData: vi.fn() }))
vi.mock('./dashboard', () => ({ resetDashboardData }))

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
  tryRefreshMock: vi.fn<() => Promise<RefreshOutcome>>(),
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
    tryRefreshMock.mockResolvedValue('refreshed')

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
    tryRefreshMock.mockResolvedValue('unauthorized')

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
    expect(resetCalendarData).toHaveBeenCalledTimes(1)
    expect(resetListData).toHaveBeenCalledTimes(1)

    await useAuthStore.getState().logout()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
    expect(resetCalendarData).toHaveBeenCalledTimes(2)
    expect(resetListData).toHaveBeenCalledTimes(2)
  })

  it('resets dashboard state on logout', async () => {
    apiLogout.mockResolvedValue(undefined)
    useAuthStore.setState({ status: 'authenticated', user })
    await useAuthStore.getState().logout()
    expect(resetDashboardData).toHaveBeenCalledTimes(1)
  })

  it('cancels an active confirmation on logout', async () => {
    apiLogout.mockResolvedValue(undefined)
    const pendingConfirmation = confirm('Delete this?')

    await useAuthStore.getState().logout()

    await expect(pendingConfirmation).resolves.toBe(false)
  })

  it('resets dashboard state when unauthenticated init settles', async () => {
    apiGetMe.mockResolvedValue(null)
    tryRefreshMock.mockResolvedValue('unauthorized')
    await useAuthStore.getState().init()
    expect(resetDashboardData).toHaveBeenCalledTimes(1)
  })

  it('resets dashboard state on a fresh login, before authenticating', async () => {
    apiLogin.mockResolvedValue(user)
    await useAuthStore.getState().login('user@example.com', 'pw')
    expect(resetDashboardData).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().status).toBe('authenticated')
  })

  it('resets dashboard state on email verification', async () => {
    apiVerifyEmail.mockResolvedValue(user)
    await useAuthStore.getState().verifyEmail('tok')
    expect(resetDashboardData).toHaveBeenCalledTimes(1)
  })

  it('drops a profile update whose response lands after a session boundary', async () => {
    const USER_B = { id: 'b', email: 'b@x.com', display_name: 'B', preferences: {} } as User
    useAuthStore.setState({ status: 'authenticated', user: USER_B })

    let resolveUpdate!: (u: User) => void
    apiUpdateProfile.mockReturnValue(
      new Promise<User>((r) => {
        resolveUpdate = r
      }),
    )

    const pending = useAuthStore.getState().updateProfile({ display_name: 'A-new' })
    bumpSessionGeneration() // account boundary crosses while the request is in flight
    resolveUpdate({ id: 'a', email: 'a@x.com', display_name: 'A-new', preferences: {} } as User)
    await pending

    expect(useAuthStore.getState().user).toBe(USER_B) // A's response was dropped
  })

  it('drops a preferences update whose response lands after a session boundary', async () => {
    const USER_B = { id: 'b', email: 'b@x.com', display_name: 'B', preferences: {} } as User
    useAuthStore.setState({ status: 'authenticated', user: USER_B })

    let resolveUpdate!: (u: User) => void
    apiUpdatePreferences.mockReturnValue(
      new Promise<User>((r) => {
        resolveUpdate = r
      }),
    )

    const pending = useAuthStore.getState().updatePreferences({} as never)
    bumpSessionGeneration()
    resolveUpdate({ id: 'a', email: 'a@x.com', display_name: 'A', preferences: {} } as User)
    await pending

    expect(useAuthStore.getState().user).toBe(USER_B)
  })

  it('marks the session unauthenticated before apiLogout resolves', async () => {
    useAuthStore.setState({ status: 'authenticated', user: { id: 'b' } as User })
    let resolveLogout!: () => void
    apiLogout.mockReturnValue(
      new Promise<void>((r) => {
        resolveLogout = r
      }),
    )

    const pending = useAuthStore.getState().logout()
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()

    resolveLogout()
    await pending
  })
})
