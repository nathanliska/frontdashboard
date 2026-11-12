import { vi } from 'vitest'
import { toastMock } from './toast'

/**
 * The dashboard store's network and side-effect surface, stubbed once for its test files to wire
 * in through async `vi.mock` factories. Must not import the store, or a factory would re-enter it.
 */
export const apiUpdatePreferences = vi.fn()

export const apiAddWidget = vi.fn()
export const apiCreateDashboard = vi.fn()
export const apiDeleteDashboard = vi.fn()
export const apiGetDashboard = vi.fn()
export const apiGetTrash = vi.fn()
export const apiListDashboards = vi.fn()
export const apiRemoveWidget = vi.fn()
export const apiPurgeDashboard = vi.fn()
export const apiRestoreDashboard = vi.fn()
export const apiTransferDashboardOwnership = vi.fn()
export const apiUpdateDashboardMeta = vi.fn()
export const apiUpdateLayout = vi.fn()
export const apiUpdateWidget = vi.fn()

export const toastError = vi.fn()
export const applyCreatedList = vi.fn()

export const listDataMock = { applyCreatedList }

export const authApiMock = {
  apiChangePassword: vi.fn(),
  apiGetMe: vi.fn(),
  apiLogin: vi.fn(),
  apiLogout: vi.fn(),
  apiRegister: vi.fn(),
  apiUpdatePreferences,
  apiUpdateProfile: vi.fn(),
}

export const dashboardsApiMock = {
  apiAddWidget,
  apiCreateDashboard,
  apiDeleteDashboard,
  apiGetDashboard,
  apiGetTrash,
  apiListDashboards,
  apiRemoveWidget,
  apiPurgeDashboard,
  apiRestoreDashboard,
  apiTransferDashboardOwnership,
  apiUpdateDashboardMeta,
  apiUpdateLayout,
  apiUpdateWidget,
}

export const toastStoreMock = () => toastMock({ error: toastError })
