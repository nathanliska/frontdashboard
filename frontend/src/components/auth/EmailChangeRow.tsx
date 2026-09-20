import { Mail, X } from 'lucide-react'
import { type FormEvent, useRef, useState } from 'react'
import { apiRequestEmailChange } from '../../api/auth'
import { ApiError } from '../../api/http'
import { FormField } from '../ui/FormField'

/** The profile card's "Email" row: asks for the new address and the password, then says to check it. */
export function EmailChangeRow({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({})
  const toggle = useRef<HTMLButtonElement>(null)
  // Dropped once the address shown is the one asked for: the link was confirmed somewhere.
  const pending = sentTo && sentTo.toLowerCase() !== email.toLowerCase() ? sentTo : null

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const newEmail = String(form.get('new-email') ?? '').trim()
    const password = String(form.get('email-change-password') ?? '')
    const problems: { email?: string; password?: string } = {}
    if (!newEmail) problems.email = 'Enter the new email address.'
    else if (newEmail.toLowerCase() === email.toLowerCase())
      problems.email = 'This is already your email.'
    if (!password) problems.password = 'Enter your password.'
    setErrors(problems)
    if (Object.keys(problems).length > 0) return

    setBusy(true)
    try {
      await apiRequestEmailChange(newEmail, password)
      setSentTo(newEmail)
      setOpen(false)
      // The submit button is about to unmount, which would drop focus to the body.
      toggle.current?.focus()
    } catch (error) {
      const status = error instanceof ApiError ? error.status : null
      // A 403's detail is a sentence (the password, or CSRF); a 422's is a list, so it is reworded.
      if (status === 403) setErrors({ password: (error as ApiError).message })
      else if (status === 422) setErrors({ email: 'Enter a valid email address.' })
      else if (status === 429) setErrors({ form: 'Too many attempts. Try again in a minute.' })
      else if (status === null)
        setErrors({ form: 'Could not send the link. Check your connection and try again.' })
      else setErrors({ form: 'Could not send the link. Try again in a moment.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-t border-zinc-800/80 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <Mail size={15} className="mt-0.5 shrink-0 text-zinc-500" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">Email</p>
            {/* Says the same thing whether or not the address was free: the server does too (ADR-011). */}
            <p className="mt-0.5 text-xs text-zinc-500" role="status">
              {pending
                ? `If ${pending} can be used, we sent it a link. Your email stays ${email} until that link is confirmed.`
                : 'The address you sign in with, and where reset links go.'}
            </p>
          </div>
        </div>
        <button
          ref={toggle}
          type="button"
          onClick={() => {
            setErrors({})
            setOpen((value) => !value)
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          {open ? <X size={14} /> : <Mail size={14} />}
          {open ? 'Close' : 'Change email'}
        </button>
      </div>

      {open ? (
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-4 border-t border-zinc-800/80 px-5 py-4"
        >
          <FormField
            id="new-email"
            name="new-email"
            label="New email"
            type="email"
            autoComplete="email"
            hint="We send it a link to confirm, and tell your current address that a change was asked for."
            error={errors.email}
            required
          />
          <FormField
            id="email-change-password"
            name="email-change-password"
            label="Confirm your password"
            type="password"
            autoComplete="current-password"
            error={errors.password}
            required
          />
          {errors.form && (
            <p className="text-sm text-red-400" role="alert">
              {errors.form}
            </p>
          )}
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:opacity-60"
            >
              {busy ? 'Sending...' : 'Send confirmation link'}
            </button>
          </div>
        </form>
      ) : null}
    </>
  )
}
