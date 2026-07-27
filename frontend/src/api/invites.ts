import { z } from 'zod'
import { apiFetch } from './client'
import {
  InviteAcceptResponse,
  InviteCreatedResponse,
  InvitePreviewResponse,
  InviteResponse,
} from './generated/contract'
import { parseJson, readError, requestVoid } from './http'
import type { ShareRole } from './shares'

export type {
  InviteAcceptResponse,
  InviteCreatedResponse,
  InvitePreviewResponse,
  InviteResponse as DashboardInvite,
} from './generated/contract'

export async function apiCreateInvite(
  dashboardId: string,
  role: ShareRole,
): Promise<InviteCreatedResponse> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  if (!res.ok) throw await readError(res, 'Failed to create an invite link.')
  return parseJson(res, InviteCreatedResponse)
}

// Single-flighted for the same reason as apiGetDashboardShares: the share panel fetches from an
// effect with no coalescing layer above it, and StrictMode double-invokes that effect in
// development.
const inviteListRequests = new Map<string, Promise<InviteResponse[]>>()

export async function apiGetInvites(dashboardId: string): Promise<InviteResponse[]> {
  const existing = inviteListRequests.get(dashboardId)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/dashboards/${dashboardId}/invites`)
    if (!res.ok) throw await readError(res, 'Failed to load invite links.')
    return parseJson(res, z.array(InviteResponse))
  })().finally(() => {
    inviteListRequests.delete(dashboardId)
  })

  inviteListRequests.set(dashboardId, request)
  return request
}

export async function apiRevokeInvite(dashboardId: string, inviteId: string): Promise<void> {
  await requestVoid(
    `/api/dashboards/${dashboardId}/invites/${inviteId}`,
    { method: 'DELETE' },
    'Failed to revoke the invite link.',
  )
}

// In-flight only — a preview must stay fresh (the invite can be spent at any moment), so this
// dedupes the StrictMode double-mount without caching the result.
const invitePreviewRequests = new Map<string, Promise<InvitePreviewResponse>>()

/** Describe an invite without redeeming it. Works signed out — the code is the credential. */
export async function apiPreviewInvite(code: string): Promise<InvitePreviewResponse> {
  const existing = invitePreviewRequests.get(code)
  if (existing) return existing

  const request = (async () => {
    const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}`)
    if (!res.ok) throw await readError(res, 'This invite link is no longer valid.')
    return parseJson(res, InvitePreviewResponse)
  })().finally(() => {
    invitePreviewRequests.delete(code)
  })

  invitePreviewRequests.set(code, request)
  return request
}

export async function apiAcceptInvite(code: string): Promise<InviteAcceptResponse> {
  const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' })
  if (!res.ok) throw await readError(res, 'This invite link is no longer valid.')
  return parseJson(res, InviteAcceptResponse)
}
