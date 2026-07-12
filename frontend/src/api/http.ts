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
