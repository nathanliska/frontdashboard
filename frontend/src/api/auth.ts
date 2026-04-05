import { apiFetch } from './client'

export interface UserPreferences {
  home_dashboard_id?: string | null
}

export interface User {
  id: string
  email: string
  display_name: string
  preferences: UserPreferences
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new Error(data.detail ?? fallback)
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
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Login failed')
  }
  return res.json() as Promise<User>
}

// Register doesn't require auth, so no CSRF cookie yet — use plain fetch
export async function apiRegister(
  email: string,
  password: string,
  display_name: string,
): Promise<User> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(data.detail ?? 'Registration failed')
  }
  return res.json() as Promise<User>
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

export async function apiUpdateProfile(input: {
  email?: string
  display_name?: string
}): Promise<User> {
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
