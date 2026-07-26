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

export async function apiGetInvites(dashboardId: string): Promise<InviteResponse[]> {
  const res = await apiFetch(`/api/dashboards/${dashboardId}/invites`)
  if (!res.ok) throw await readError(res, 'Failed to load invite links.')
  return parseJson(res, z.array(InviteResponse))
}

export async function apiRevokeInvite(dashboardId: string, inviteId: string): Promise<void> {
  await requestVoid(
    `/api/dashboards/${dashboardId}/invites/${inviteId}`,
    { method: 'DELETE' },
    'Failed to revoke the invite link.',
  )
}

/** Describe an invite without redeeming it. Works signed out — the code is the credential. */
export async function apiPreviewInvite(code: string): Promise<InvitePreviewResponse> {
  const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}`)
  if (!res.ok) throw await readError(res, 'This invite link is no longer valid.')
  return parseJson(res, InvitePreviewResponse)
}

export async function apiAcceptInvite(code: string): Promise<InviteAcceptResponse> {
  const res = await apiFetch(`/api/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' })
  if (!res.ok) throw await readError(res, 'This invite link is no longer valid.')
  return parseJson(res, InviteAcceptResponse)
}
