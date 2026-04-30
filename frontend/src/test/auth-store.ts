import { vi } from 'vitest'
import type { RegistrationResponse, User } from '../api/auth'

export interface MockAuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  user: User | null
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<RegistrationResponse>
  verifyEmail: (token: string) => Promise<void>
  logout: () => Promise<void>
  updatePreferences: (prefs: User['preferences']) => Promise<void>
  updateProfile: (input: { display_name?: string }) => Promise<void>
  changePassword: (input: { current_password: string; new_password: string }) => Promise<void>
}

export const mockUseAuthStore = vi.fn()

export function createMockAuthState(overrides: Partial<MockAuthState> = {}): MockAuthState {
  return {
    status: 'loading',
    user: null,
    init: vi.fn().mockResolvedValue(undefined),
    login: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue({
      email: 'user@example.com',
    }),
    verifyEmail: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    updatePreferences: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

export function setMockAuthState(state: MockAuthState) {
  mockUseAuthStore.mockImplementation((selector: (value: MockAuthState) => unknown) =>
    selector(state),
  )
}

export function resetMockAuthStore() {
  mockUseAuthStore.mockReset()
}
