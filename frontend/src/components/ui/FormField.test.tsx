// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormField } from './FormField'

describe('FormField', () => {
  it('leaves a valid field unmarked and undescribed', () => {
    render(<FormField id="name" label="Display name" />)

    const input = screen.getByLabelText('Display name')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).not.toHaveAttribute('aria-describedby')
  })

  it('attaches the error to the field it belongs to', () => {
    render(<FormField id="name" label="Display name" error="Display name is required." />)

    const input = screen.getByLabelText('Display name')
    const message = screen.getByRole('alert')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    // The point of the finding: the message is owned by the input, not floating in a toast.
    expect(input).toHaveAttribute('aria-describedby', message.id)
    expect(message).toHaveTextContent('Display name is required.')
  })

  it('describes the field by both hint and error when both are present', () => {
    render(
      <FormField
        id="new-password"
        label="New password"
        hint="At least 8 characters."
        error="Use at least 8 characters."
      />,
    )

    const describedBy = screen.getByLabelText('New password').getAttribute('aria-describedby')
    expect(describedBy).toBe('new-password-error new-password-hint')
  })
})
