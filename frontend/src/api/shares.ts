// Re-exported from the generated backend contract (frontend/src/api/generated/contract.ts).
// Aliased to the names consumers already import — see CLAUDE.md "Sharing model".
export type {
  InheritedDashboardAccessResponse as InheritedDashboardAccess,
  PrincipalType,
  ResourceAccessResponse as ResourceAccessSummary,
  ShareResponse as ResourceShare,
  ShareRole,
  ShareUpdate,
} from './generated/contract'

import type { ShareResponse } from './generated/contract'

/**
 * The grant body the child-share scaffolding would send. The dashboard route that defined this
 * shape left the contract when direct grants were removed, so it is composed from the response
 * fields that remain.
 */
export type ShareCreate = Pick<ShareResponse, 'principal_type' | 'principal_id' | 'role'>
