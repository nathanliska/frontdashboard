import { describe, expect, it } from 'vitest'
import { chunksForPath } from './routePreload'
import { ROUTES } from './routes'

describe('chunksForPath', () => {
  it('names the chunk for every protected route shape', () => {
    expect(chunksForPath('/')).toEqual(['DashboardEditorPage', 'DashboardsPage'])
    expect(chunksForPath('/dashboards')).toEqual(['DashboardsPage'])
    expect(chunksForPath('/dashboard/b6018408-7eb3-4b4a-98fb-917262f06170')).toEqual([
      'DashboardEditorPage',
    ])
    expect(chunksForPath('/calendar')).toEqual(['CalendarPage'])
    expect(chunksForPath('/lists')).toEqual(['ListsLayout'])
    expect(chunksForPath('/lists/some-list-id')).toEqual(['ListsLayout', 'ListDetailPage'])
    expect(chunksForPath('/notifications')).toEqual(['NotificationsPage'])
    expect(chunksForPath('/profile')).toEqual(['ProfilePage'])
  })

  it('names nothing for public or unknown paths, where fetching app chunks is pure waste', () => {
    for (const path of [
      ROUTES.login,
      ROUTES.register,
      ROUTES.forgotPassword,
      ROUTES.resetPassword,
      ROUTES.verifyEmail,
      '/invite/SOMECODE',
      '/listsmash',
      '/definitely-not-a-route',
    ]) {
      expect(chunksForPath(path)).toEqual([])
    }
  })
})
