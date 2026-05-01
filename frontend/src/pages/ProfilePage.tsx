import { Home, LockKeyhole, Pencil, X } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ROUTES } from '../routes'
import { useAuthStore } from '../stores/auth'
import { useDashboardStore } from '../stores/dashboard'
import { toast } from '../stores/toast'

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
    setEditingProfile(false)
  }

  function cancelPasswordEdit() {
    setEditingPassword(false)
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const trimmedName = String(formData.get('display-name') ?? '').trim()
    if (!trimmedName) {
      toast.error('Display name is required.')
      return
    }

    if (trimmedName === currentUser.display_name) {
      toast.error('No profile changes to save.')
      return
    }

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
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error('Fill out all password fields.')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match.')
      return
    }
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters.')
      return
    }

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
            <div className="space-y-1.5">
              <label
                htmlFor="display-name"
                className="flex items-center gap-2 text-xs text-zinc-500"
              >
                Display name
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="display-name"
                  name="display-name"
                  defaultValue={currentUser.display_name}
                  required
                  className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-700 focus:outline-none"
                />
                <div className="flex shrink-0 items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelProfileEdit}
                    className="rounded-lg px-3 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:opacity-60"
                  >
                    {savingProfile ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
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
            <label className="grid gap-1.5 text-sm">
              <span className="text-zinc-400">Current password</span>
              <input
                name="current-password"
                type="password"
                autoComplete="current-password"
                required
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:border-zinc-700 focus:outline-none"
              />
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="text-zinc-400">New password</span>
              <input
                name="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:border-zinc-700 focus:outline-none"
              />
            </label>

            <label className="grid gap-1.5 text-sm">
              <span className="text-zinc-400">Confirm new password</span>
              <input
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:border-zinc-700 focus:outline-none"
              />
            </label>

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
