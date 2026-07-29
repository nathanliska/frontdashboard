import type { InputHTMLAttributes, Ref } from 'react'
import { cn } from '../../utils/shared/cn'

/** A labelled input whose error is attached to the field itself (#27).
 *
 * The label is wired with `htmlFor`, the message owned by the field via `aria-describedby`, and
 * `aria-invalid` marks the control — so a screen reader announces the error when focus lands on the
 * offending input, and it persists until the user fixes it. A toast cannot do either: it appears
 * away from the input, never says which field it belongs to, and vanishes on a timer.
 *
 * `role="alert"` on the message means a validation failure is also announced immediately on
 * submit, without moving focus.
 */
export function FormField({
  id,
  label,
  error,
  hint,
  inputRef,
  className,
  ...inputProps
}: {
  id: string
  label: string
  error?: string | null
  hint?: string
  inputRef?: Ref<HTMLInputElement>
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>) {
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')

  return (
    <div className="grid gap-1.5 text-sm">
      <label htmlFor={id} className="text-zinc-400">
        {label}
      </label>
      <input
        {...inputProps}
        id={id}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cn(
          'rounded-lg border bg-zinc-950 px-3 py-2 text-zinc-100 focus:outline-none',
          error
            ? 'border-red-500/60 focus:border-red-500'
            : 'border-zinc-800 focus:border-zinc-700',
          className,
        )}
      />
      {hint && (
        <p id={hintId} className="text-xs text-zinc-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
