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
import { tryRefresh } from '../api/client'
import { resetAgendaData } from '../resources/agendaData'
import { resetCalendarData } from '../resources/calendarData'
import { resetListData } from '../resources/listData'
import { useNotificationsStore } from './notifications'
import { toast } from './toast'

let authInitPromise: Promise<void> | null = null

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

    authInitPromise = (async () => {
      const resetNotifications = useNotificationsStore.getState().reset
      const resetSessionData = () => {
        resetNotifications()
        resetAgendaData()
        resetCalendarData()
        resetListData()
      }
      // Try current access token first
      let user = await apiGetMe()
      if (user) {
        set({ status: 'authenticated', user })
        return
      }
      // Access token may be expired — attempt silent refresh
      const outcome = await tryRefresh()
      if (outcome === 'refreshed') {
        user = await apiGetMe()
        if (user) {
          set({ status: 'authenticated', user })
          return
        }
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
    set({ status: 'authenticated', user })
  },

  async register(email, password, displayName) {
    const registration = await apiRegister(email, password, displayName)
    set({ status: 'unauthenticated', user: null })
    return registration
  },

  async verifyEmail(token) {
    const user = await apiVerifyEmail(token)
    set({ status: 'authenticated', user })
  },

  async logout() {
    useNotificationsStore.getState().reset()
    resetAgendaData()
    resetCalendarData()
    resetListData()
    await apiLogout().catch(() => {})
    set({ status: 'unauthenticated', user: null })
  },

  async updatePreferences(prefs) {
    try {
      const updated = await apiUpdatePreferences(prefs)
      set({ user: updated })
    } catch {
      toast.error('Failed to update preferences.')
    }
  },

  async updateProfile(input) {
    try {
      const updated = await apiUpdateProfile(input)
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
