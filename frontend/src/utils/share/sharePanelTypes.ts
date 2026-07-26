import type { PrincipalType, ShareRole } from '../../api/shares'

export interface SharePanelItem {
  key: string
  principal_type: PrincipalType
  principal_id: string
  principal_name: string
  role: ShareRole
}

export interface ShareRoleOption {
  value: ShareRole
  label: string
  description?: string
}
