import { Check, Home, LockKeyhole, Pencil, X } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { FormField } from '../components/ui/FormField'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'
import { cn } from '../utils/shared/cn'

export function ProfilePage() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const updatePreferences = useAuthStore((s) => s.updatePreferences)
  const changePassword = useAuthStore((s) => s.changePassword)
  const summaries = useDashboardStore((s) => s.summaries)
  const summariesLoaded = useDashboardStore((s) => s.summariesLoaded)
  const summariesLoading = useDashboardStore((s) => s.summariesLoading)
  const loadSummaries = useDashboardStore((s) => s.loadSummaries)
  const [editingProfile, setEditingProfile] = useState(false)
  const [editingPassword, setEditingPassword] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  // Errors live per field so they can be attached to the input that caused them (#27).
  const [profileError, setProfileError] = useState<string | null>(null)
  const [passwordErrors, setPasswordErrors] = useState<{
    current?: string
    next?: string
    confirm?: string
  }>({})
  const homeDashboardId = user?.preferences?.home_dashboard_id ?? null
  const homeDashboard = useMemo(
    () =>
      homeDashboardId
        ? (summaries.find((dashboard) => dashboard.id === homeDashboardId) ?? null)
        : null,
    [homeDashboardId, summaries],
  )
  const homeDashboardLabel = homeDashboard
    ? homeDashboard.name
    : homeDashboardId && (summariesLoading || !summariesLoaded)
      ? 'Loading home dashboard...'
      : homeDashboardId
        ? 'Current dashboard unavailable'
        : 'Not set - opening the app shows the dashboards listing.'

  useEffect(() => {
    void loadSummaries()
  }, [loadSummaries])

  if (!user) return null
  const currentUser = user

  function cancelProfileEdit() {
    setProfileError(null)
    setEditingProfile(false)
  }

  function cancelPasswordEdit() {
    setPasswordErrors({})
    setEditingPassword(false)
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const trimmedName = String(formData.get('display-name') ?? '').trim()
    if (!trimmedName) {
      setProfileError('Display name is required.')
      return
    }

    if (trimmedName === currentUser.display_name) {
      setProfileError('This is already your display name.')
      return
    }

    setProfileError(null)
    setSavingProfile(true)
    try {
      await updateProfile({ display_name: trimmedName })
      setEditingProfile(false)
      toast.success('Profile updated.')
    } finally {
      setSavingProfile(false)
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const currentPassword = String(formData.get('current-password') ?? '')
    const newPassword = String(formData.get('new-password') ?? '')
    const confirmPassword = String(formData.get('confirm-password') ?? '')

    // Every failing field is marked at once, so the user fixes the form in one pass instead of
    // rediscovering the next problem on each submit.
    const errors: { current?: string; next?: string; confirm?: string } = {}
    if (!currentPassword) errors.current = 'Enter your current password.'
    if (!newPassword) errors.next = 'Enter a new password.'
    else if (newPassword.length < 8) errors.next = 'Use at least 8 characters.'
    if (!confirmPassword) errors.confirm = 'Re-enter the new password.'
    else if (newPassword && newPassword !== confirmPassword) {
      errors.confirm = 'This does not match the new password.'
    }
    setPasswordErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSavingPassword(true)
    try {
      await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      cancelPasswordEdit()
      toast.success('Password updated.')
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex min-h-10 items-center pl-12 sm:pl-0">
        <h1 className="text-xl font-semibold text-zinc-100">Profile</h1>
      </div>

      <section className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-lg font-semibold text-zinc-200">
            {user.display_name[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-medium text-zinc-100">
              {currentUser.display_name}
            </p>
            <p className="truncate text-sm text-zinc-500">{currentUser.email}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingPassword(false)
              setEditingProfile((value) => !value)
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
          >
            {editingProfile ? <X size={14} /> : <Pencil size={14} />}
            {editingProfile ? 'Close' : 'Edit'}
          </button>
        </div>

        {editingProfile ? (
          <form
            key={currentUser.display_name}
            onSubmit={(event) => void handleProfileSubmit(event)}
            className="grid gap-4 border-t border-zinc-800/80 px-5 py-4 sm:grid-cols-2"
          >
            {/* Edits in place, like `EditableListName` and the list rows: the input replaces the
                value inside the same cell, with Check/Cancel as inline icons. Full-size Save and
                Cancel buttons had to live somewhere, and wherever they went they either shoved the
                Email column out of alignment or added a row that resized the card on every edit.
                Labelled locally rather than via `FormField` so the label matches the read view's
                exactly — the aria wiring is the same either way (see frontend/CLAUDE.md). */}
            <div className="space-y-1">
              <label htmlFor="display-name" className="text-xs text-zinc-500">
                Display name
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="display-name"
                  name="display-name"
                  defaultValue={currentUser.display_name}
                  aria-invalid={profileError ? true : undefined}
                  aria-describedby={profileError ? 'display-name-error' : undefined}
                  onChange={() => setProfileError(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelProfileEdit()
                    }
                  }}
                  required
                  className={cn(
                    'min-w-0 flex-1 rounded border bg-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:outline-none',
                    profileError
                      ? 'border-red-500/60 focus:border-red-500'
                      : 'border-zinc-700 focus:border-zinc-500',
                  )}
                />
                <button
                  type="submit"
                  disabled={savingProfile}
                  aria-label="Save display name"
                  className="p-0.5 text-zinc-500 transition-colors hover:text-zinc-100 disabled:opacity-50"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  onClick={cancelProfileEdit}
                  aria-label="Cancel editing display name"
                  className="p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  <X size={14} />
                </button>
              </div>
              <p
                id="display-name-error"
                role="alert"
                className="text-xs text-red-400"
                hidden={!profileError}
              >
                {profileError}
              </p>
            </div>

            <Field label="Email" value={currentUser.email} />
          </form>
        ) : (
          <div className="grid gap-4 border-t border-zinc-800/80 px-5 py-4 sm:grid-cols-2">
            <Field label="Display name" value={currentUser.display_name} />
            <Field label="Email" value={currentUser.email} />
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-zinc-800/80 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <LockKeyhole size={15} className="shrink-0 text-zinc-500" />
            <p className="text-sm font-medium text-zinc-100">Password</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingProfile(false)
              setEditingPassword((value) => !value)
              if (editingPassword) {
                cancelPasswordEdit()
              }
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
          >
            {editingPassword ? <X size={14} /> : <Pencil size={14} />}
            {editingPassword ? 'Close' : 'Change'}
          </button>
        </div>

        {editingPassword ? (
          <form
            onSubmit={(event) => void handlePasswordSubmit(event)}
            className="space-y-4 border-t border-zinc-800/80 px-5 py-4"
          >
            <FormField
              id="current-password"
              name="current-password"
              label="Current password"
              type="password"
              autoComplete="current-password"
              error={passwordErrors.current}
              required
            />

            <FormField
              id="new-password"
              name="new-password"
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 8 characters."
              error={passwordErrors.next}
              required
              minLength={8}
            />

            <FormField
              id="confirm-password"
              name="confirm-password"
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              error={passwordErrors.confirm}
              required
            />

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelPasswordEdit}
                className="rounded-lg px-3 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPassword}
                className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:opacity-60"
              >
                {savingPassword ? 'Saving...' : 'Change password'}
              </button>
            </div>
          </form>
        ) : null}

        <div className="flex items-center justify-between gap-4 border-t border-zinc-800/80 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <Home size={15} className="mt-0.5 shrink-0 text-zinc-500" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">Home dashboard</p>
              <p className="mt-0.5 truncate text-xs text-zinc-500">{homeDashboardLabel}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {homeDashboard && (
              <Link
                to={ROUTES.dashboard(homeDashboard.id)}
                className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Open
              </Link>
            )}
            {homeDashboardId && (
              <button
                type="button"
                onClick={() => void updatePreferences({ home_dashboard_id: null })}
                className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-sm text-zinc-200">{value}</p>
    </div>
  )
}
