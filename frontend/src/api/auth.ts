import { apiFetch } from './client'
import {
  PasswordResetTokenStatus,
  RegistrationResponse,
  type SessionCursor,
  SessionPage,
  type UserPreferences,
  UserResponse,
} from './generated/contract'
import { parseJson, readError } from './http'

export type { RegistrationResponse, UserPreferences } from './generated/contract'
export { ApiError } from './http'

// Generated `UserResponse` re-exported under the name consumers already import.
export type User = UserResponse

/** Null means the server said we are not signed in. Anything else throws: an outage is not a logout. */
export async function apiGetMe(): Promise<User | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  if (res.status === 401) return null
  if (!res.ok) throw await readError(res, 'Could not load your account')
  return parseJson(res, UserResponse)
}

export async function apiLogin(email: string, password: string): Promise<User> {
  // Plain fetch: apiFetch reads the 401 from wrong credentials as a lost session, but there was
  // no session to lose — and the caller wants the error.
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    throw await readError(res, 'Login failed')
  }
  return parseJson(res, UserResponse)
}

// Register doesn't require auth, so no CSRF cookie yet — use plain fetch
export async function apiRegister(
  email: string,
  password: string,
  display_name: string,
): Promise<RegistrationResponse> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name }),
  })
  if (!res.ok) {
    throw await readError(res, 'Registration failed')
  }
  return parseJson(res, RegistrationResponse)
}

export async function apiVerifyEmail(token: string): Promise<User> {
  const res = await fetch('/api/auth/verify-email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw await readError(res, 'Email verification failed')
  return parseJson(res, UserResponse)
}

export async function apiResendVerification(email: string): Promise<void> {
  const res = await fetch('/api/auth/resend-verification', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw await readError(res, 'Failed to resend verification email')
}

export async function apiRequestPasswordReset(email: string): Promise<void> {
  const res = await fetch('/api/auth/password-reset/request', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw await readError(res, 'Failed to send password reset email')
}

export async function apiCheckPasswordResetToken(token: string): Promise<boolean> {
  const res = await fetch('/api/auth/password-reset/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw await readError(res, 'Failed to check reset link')
  return (await parseJson(res, PasswordResetTokenStatus)).valid
}

export async function apiConfirmPasswordReset(token: string, new_password: string): Promise<void> {
  const res = await fetch('/api/auth/password-reset/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, new_password }),
  })
  if (!res.ok) throw await readError(res, 'Failed to reset password')
}

export async function apiLogout(): Promise<void> {
  const res = await apiFetch('/api/auth/logout', { method: 'POST' })
  // A 401 means there was no session left to end, which is what logout wanted.
  if (!res.ok && res.status !== 401) throw await readError(res, 'Sign-out did not reach the server')
}

export async function apiUpdatePreferences(prefs: UserPreferences): Promise<User> {
  const res = await apiFetch('/api/auth/preferences', {
    method: 'PATCH',
    body: JSON.stringify(prefs),
  })
  if (!res.ok) throw await readError(res, 'Failed to update preferences')
  return parseJson(res, UserResponse)
}

export async function apiUpdateProfile(input: { display_name?: string }): Promise<User> {
  const res = await apiFetch('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await readError(res, 'Failed to update profile')
  return parseJson(res, UserResponse)
}

export async function apiChangePassword(input: {
  current_password: string
  new_password: string
}): Promise<void> {
  const res = await apiFetch('/api/auth/password', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await readError(res, 'Failed to update password')
}

/** A bounded page of live sessions; the cursor remains usable after revoking its boundary row. */
export async function apiListSessions(cursor: SessionCursor | null): Promise<SessionPage> {
  const query = cursor
    ? `?${new URLSearchParams({ before: cursor.created_at, before_id: cursor.id })}`
    : ''
  const res = await apiFetch(`/api/auth/sessions${query}`)
  if (!res.ok) throw await readError(res, 'Failed to load sessions')
  return parseJson(res, SessionPage)
}

/** Revoke another session; the current session is ended through the regular logout flow. */
export async function apiRevokeSession(id: string): Promise<void> {
  const res = await apiFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw await readError(res, 'Failed to revoke session')
}
