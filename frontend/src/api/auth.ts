import { apiFetch } from './client'

export interface UserPreferences {
  home_dashboard_id?: string | null
  favorite_dashboard_ids?: string[]
}

export interface User {
  id: string
  email: string
  display_name: string
  preferences: UserPreferences
  email_verified_at?: string | null
}

export interface RegistrationResponse {
  email: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new ApiError(data.detail ?? fallback, res.status)
}

// Plain fetch — no refresh loop; caller decides what to do on 401
export async function apiGetMe(): Promise<User | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' })
    if (!res.ok) return null
    return res.json() as Promise<User>
  } catch {
    return null
  }
}

export async function apiLogin(email: string, password: string): Promise<User> {
  // Plain fetch: login is public — backend returns 401 for wrong credentials,
  // and apiFetch would intercept that to trigger a token refresh instead of
  // propagating the error.
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    throw await readError(res, 'Login failed')
  }
  return res.json() as Promise<User>
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
  return res.json() as Promise<RegistrationResponse>
}

export async function apiVerifyEmail(token: string): Promise<User> {
  const res = await fetch('/api/auth/verify-email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) throw await readError(res, 'Email verification failed')
  return res.json() as Promise<User>
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

export async function apiLogout(): Promise<void> {
  await apiFetch('/api/auth/logout', { method: 'POST' })
}

export async function apiUpdatePreferences(prefs: UserPreferences): Promise<User> {
  const res = await apiFetch('/api/auth/preferences', {
    method: 'PATCH',
    body: JSON.stringify(prefs),
  })
  if (!res.ok) throw await readError(res, 'Failed to update preferences')
  return res.json() as Promise<User>
}

export async function apiUpdateProfile(input: { display_name?: string }): Promise<User> {
  const res = await apiFetch('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await readError(res, 'Failed to update profile')
  return res.json() as Promise<User>
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
