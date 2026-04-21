import { LockKeyhole, Mail, Pencil, UserRound, X } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useAuthStore } from '../stores/auth'
import { toast } from '../stores/toast'

export function ProfilePage() {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const changePassword = useAuthStore((s) => s.changePassword)
  const [editingProfile, setEditingProfile] = useState(false)
  const [editingPassword, setEditingPassword] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

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
    const trimmedEmail = String(formData.get('email') ?? '').trim()
    if (!trimmedName || !trimmedEmail) {
      toast.error('Display name and email are required.')
      return
    }

    if (trimmedName === currentUser.display_name && trimmedEmail === currentUser.email) {
      toast.error('No profile changes to save.')
      return
    }

    setSavingProfile(true)
    try {
      await updateProfile({
        display_name: trimmedName,
        email: trimmedEmail,
      })
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
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="pl-12 sm:pl-0 min-h-10 flex items-center">
        <h1 className="text-xl font-semibold text-zinc-100">Profile</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-200 text-lg font-semibold shrink-0">
                {user.display_name[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium text-zinc-100 truncate">
                  {currentUser.display_name}
                </p>
                <p className="text-sm text-zinc-500 truncate">{currentUser.email}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingPassword(false)
                  setEditingProfile(true)
                }}
                className="shrink-0 flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              >
                <Pencil size={14} />
                Edit
              </button>
            </div>
          </div>

          {editingProfile ? (
            <form
              key={`${currentUser.display_name}:${currentUser.email}`}
              onSubmit={(event) => void handleProfileSubmit(event)}
              className="px-5 py-4 space-y-4"
            >
              <label className="grid gap-1.5 text-sm">
                <span className="flex items-center gap-2 text-zinc-400">
                  <UserRound size={14} />
                  Display name
                </span>
                <input
                  name="display-name"
                  defaultValue={currentUser.display_name}
                  required
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="flex items-center gap-2 text-zinc-400">
                  <Mail size={14} />
                  Email
                </span>
                <input
                  name="email"
                  type="email"
                  defaultValue={currentUser.email}
                  required
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelProfileEdit}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-60"
                >
                  {savingProfile ? 'Saving...' : 'Save profile'}
                </button>
              </div>
            </form>
          ) : (
            <div className="px-5 py-4 space-y-3">
              <Field label="Display name" value={currentUser.display_name} />
              <Field label="Email" value={currentUser.email} />
            </div>
          )}
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <LockKeyhole size={15} className="text-zinc-500" />
              <p className="text-sm font-medium text-zinc-100 flex-1">Password</p>
              <button
                type="button"
                onClick={() => {
                  setEditingProfile(false)
                  setEditingPassword((value) => !value)
                  if (editingPassword) {
                    cancelPasswordEdit()
                  }
                }}
                className="shrink-0 flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100 hover:border-zinc-700 transition-colors"
              >
                {editingPassword ? <X size={14} /> : <Pencil size={14} />}
                {editingPassword ? 'Close' : 'Change'}
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Update your password. You will stay signed in after saving.
            </p>
          </div>

          {editingPassword ? (
            <form
              onSubmit={(event) => void handlePasswordSubmit(event)}
              className="px-5 py-4 space-y-4"
            >
              <label className="grid gap-1.5 text-sm">
                <span className="text-zinc-400">Current password</span>
                <input
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
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
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </label>

              <label className="grid gap-1.5 text-sm">
                <span className="text-zinc-400">Confirm new password</span>
                <input
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-700"
                />
              </label>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelPasswordEdit}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPassword}
                  className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-white transition-colors disabled:opacity-60"
                >
                  {savingPassword ? 'Saving...' : 'Change password'}
                </button>
              </div>
            </form>
          ) : (
            <div className="px-5 py-4">
              <p className="text-sm text-zinc-400">Password is hidden for security.</p>
              <p className="mt-1 text-xs text-zinc-500">
                Use the change action when you want to update it.
              </p>
            </div>
          )}
        </section>
      </div>
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
