import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/auth'
import { getVerificationErrorMessage } from './VerifyEmailPage'

describe('getVerificationErrorMessage', () => {
  it('routes an already-verified 409 to sign in', () => {
    const msg = getVerificationErrorMessage(
      new ApiError('Email already verified. Please sign in.', 409),
    )
    expect(msg).toBe('Your email is already verified — please sign in below.')
  })

  it('keeps the resend guidance for a 400', () => {
    const msg = getVerificationErrorMessage(new ApiError('bad', 400))
    expect(msg).toBe('That verification link is invalid or expired. Request a new link below.')
  })

  it('falls back to the error message otherwise', () => {
    expect(getVerificationErrorMessage(new Error('boom'))).toBe('boom')
  })
})
