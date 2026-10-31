import type { ZodType } from 'zod'
import { apiFetch } from './client'

export class ApiError extends Error {
  status: number
  /** The server's own sentence, when it sent one rather than a validation list or nothing. */
  detail?: string

  constructor(message: string, status: number, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

export async function readError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => ({}))) as { detail?: unknown }
  // A request-validation 422 carries a list here; as a message it would read "[object Object]".
  const detail = typeof data.detail === 'string' ? data.detail : undefined
  return new ApiError(detail ?? fallback, res.status, detail)
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
