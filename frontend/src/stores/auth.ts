import { create } from 'zustand'
import {
  apiChangePassword,
  apiGetMe,
  apiLogin,
  apiLogout,
  apiRegister,
  apiUpdatePreferences,
  apiUpdateProfile,
  apiVerifyEmail,
  type RegistrationResponse,
  type User,
  type UserPreferences,
} from '../api/auth'
import { setSessionExpiredHandler } from '../api/client'
import { resetAllResourceData } from '../resources/resetRegistry'
import { useConfirmStore } from './confirm'
import { resetDashboardData } from './dashboard'
import { useNotificationsStore } from './notifications'
import { currentSessionGeneration } from './sessionGeneration'
import { toast } from './toast'

let authInitPromise: Promise<void> | null = null

function resetSessionData(): void {
  useConfirmStore.getState().reset()
  useNotificationsStore.getState().reset()
  // Resource caches register their own reset when they load, so a cache that was never loaded
  // holds nothing to clear and one added later needs no edit here.
  resetAllResourceData()
  // Last: it bumps the session generation that guards in-flight callbacks.
  resetDashboardData()
}

interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  user: User | null
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<RegistrationResponse>
  verifyEmail: (token: string) => Promise<void>
  logout: () => Promise<void>
  updatePreferences: (prefs: UserPreferences) => Promise<void>
  updateProfile: (input: { display_name?: string }) => Promise<void>
  changePassword: (input: { current_password: string; new_password: string }) => Promise<void>
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'loading',
  user: null,

  async init() {
    if (get().status !== 'loading') return
    if (authInitPromise) return authInitPromise

    setSessionExpiredHandler(handleSessionExpired)
    authInitPromise = (async () => {
      // One question, one answer. There is no silent-refresh step any more: the session cookie
      // either resolves to a live row or it does not, so /me is the whole of the check.
      const user = await apiGetMe()
      if (user) {
        set({ status: 'authenticated', user })
        return
      }
      resetSessionData()
      set({ status: 'unauthenticated', user: null })
    })().finally(() => {
      authInitPromise = null
    })

    return authInitPromise
  },

  async login(email, password) {
    const user = await apiLogin(email, password)
    resetSessionData()
    set({ status: 'authenticated', user })
  },

  async register(email, password, displayName) {
    const registration = await apiRegister(email, password, displayName)
    set({ status: 'unauthenticated', user: null })
    return registration
  },

  async verifyEmail(token) {
    const user = await apiVerifyEmail(token)
    resetSessionData()
    set({ status: 'authenticated', user })
  },

  async logout() {
    set({ status: 'unauthenticated', user: null }) // closes the SSE stream via useSSE cleanup
    resetSessionData() // clears stores + bumps the generation
    await apiLogout().catch(() => {})
  },

  async updatePreferences(prefs) {
    const gen = currentSessionGeneration()
    try {
      const updated = await apiUpdatePreferences(prefs)
      if (gen !== currentSessionGeneration()) return // boundary crossed mid-request — drop the write
      set({ user: updated })
    } catch {
      toast.error('Failed to update preferences.')
    }
  },

  async updateProfile(input) {
    const gen = currentSessionGeneration()
    try {
      const updated = await apiUpdateProfile(input)
      if (gen !== currentSessionGeneration()) return // boundary crossed mid-request — drop the write
      set({ user: updated })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile.')
      throw err
    }
  },

  async changePassword(input) {
    try {
      await apiChangePassword(input)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update password.')
      throw err
    }
  },
}))

/**
 * A 401 from any request means the session is gone — revoked elsewhere, idled out, or past its
 * absolute expiry. Transition the store and let `RequireAuth` route to the login page.
 *
 * Deliberately *not* `window.location.replace('/login')`: a full document teardown discards
 * in-memory state and the URL the user was on, so they return to wherever the login flow decides
 * rather than where they were.
 */
function handleSessionExpired(): void {
  if (useAuthStore.getState().status === 'unauthenticated') return
  resetSessionData()
  useAuthStore.setState({ status: 'unauthenticated', user: null })
}

// Registered here *and* in `init()`: module scope alone would make this depend on `stores/auth`
// being imported before the first request.
setSessionExpiredHandler(handleSessionExpired)
