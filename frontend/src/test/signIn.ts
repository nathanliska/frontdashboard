import type { User } from '../api/auth'
import { useAuthStore } from '../stores/auth'

/** Put the real auth store into the signed-in state most resource and page tests start from. */
export function signIn(overrides: Partial<User> = {}): void {
  useAuthStore.setState({
    status: 'authenticated',
    user: {
      id: 'user-1',
      email: 'user@example.com',
      display_name: 'Example User',
      preferences: {},
      ...overrides,
    },
  })
}
