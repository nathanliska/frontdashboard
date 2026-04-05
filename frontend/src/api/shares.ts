export type ShareRole = 'viewer' | 'editor'
export type PrincipalType = 'user' | 'group'

export interface ResourceShare {
  id: string
  resource_type: string
  resource_id: string
  principal_type: PrincipalType
  principal_id: string
  principal_name: string
  role: ShareRole
  granted_by: string
  created_at: string
}

export interface InheritedDashboardAccess {
  dashboard_id: string
  dashboard_name: string
}

export interface ResourceAccessSummary {
  direct_shares: ResourceShare[]
  inherited_dashboards: InheritedDashboardAccess[]
}

export interface ShareCreate {
  principal_type: PrincipalType
  principal_id: string
  role: ShareRole
}

export interface ShareUpdate {
  role: ShareRole
}
