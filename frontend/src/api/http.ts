import type { ZodType } from 'zod'
import { apiFetch } from './client'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function readError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { detail?: string }
  return new ApiError(data.detail ?? fallback, res.status)
}

export async function requestVoid(
  path: string,
  init: RequestInit,
  fallback: string,
): Promise<void> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw await readError(res, fallback)
}

/**
 * Boundary validation: parse + validate a success-path response body against a generated
 * zod schema. Throws an ApiError (same shape the toast path already expects) when the body
 * doesn't match the backend contract, instead of letting a malformed shape flow into the app.
 */
export async function parseJson<T>(res: Response, schema: ZodType<T>): Promise<T> {
  const body = await res.json().catch(() => undefined)
  const result = schema.safeParse(body)
  if (!result.success) {
    // Loud + located for debugging; uniform ApiError to the existing toast path for users.
    console.error('Response validation failed', result.error.issues)
    throw new ApiError('Received an unexpected response from the server.', res.status)
  }
  return result.data
}
