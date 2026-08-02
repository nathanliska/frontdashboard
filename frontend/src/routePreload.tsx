import { type ComponentType, lazy, useState } from 'react'
import { ROUTES } from './routes'

interface PreloadablePage {
  Component: ComponentType
  /** Resolves once the page's module is loaded and renderable without suspending. */
  preload: () => Promise<void>
}

/**
 * A lazy page that renders without suspending once its chunk has been preloaded.
 *
 * React.lazy suspends on first render even when the import has already resolved, and the
 * committed fallback then costs React's ~300ms reveal throttle. Rendering the loaded
 * module directly skips that path entirely; plain lazy() remains the fallback whenever
 * the chunk isn't here yet (in-app navigation, preload miss).
 */
function lazyPage(load: () => Promise<{ default: ComponentType }>): PreloadablePage {
  let Loaded: ComponentType | null = null
  const capture = () =>
    load().then((module) => {
      Loaded = module.default
      return module
    })
  const Lazy = lazy(capture)
  function Page() {
    // Chosen once per mount: switching implementations mid-life would remount the page.
    const [Impl] = useState<ComponentType>(() => Loaded ?? Lazy)
    return <Impl />
  }
  return {
    Component: Page,
    preload: async () => {
      await capture()
    },
  }
}

/** The lazy page chunks, shared by the route table and the boot preload. */
export const pages = {
  CalendarPage: lazyPage(() =>
    import('./pages/CalendarPage').then((m) => ({ default: m.CalendarPage })),
  ),
  DashboardEditorPage: lazyPage(() =>
    import('./pages/DashboardEditorPage').then((m) => ({ default: m.DashboardEditorPage })),
  ),
  DashboardsPage: lazyPage(() =>
    import('./pages/DashboardsPage').then((m) => ({ default: m.DashboardsPage })),
  ),
  ListDetailPage: lazyPage(() =>
    import('./pages/ListDetailPage').then((m) => ({ default: m.ListDetailPage })),
  ),
  ListsLayout: lazyPage(() =>
    import('./pages/ListsLayout').then((m) => ({ default: m.ListsLayout })),
  ),
  NotificationsPage: lazyPage(() =>
    import('./pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
  ),
  ProfilePage: lazyPage(() =>
    import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })),
  ),
} as const

type PageChunk = keyof typeof pages

/**
 * Names the chunks the given location will render, so boot can fetch them while /auth/me
 * is still in flight.
 *
 * `/` names both candidates because the home redirect's target depends on a preference
 * the auth response hasn't delivered yet. Public and unknown paths name none.
 */
export function chunksForPath(pathname: string): PageChunk[] {
  if (pathname === ROUTES.home) return ['DashboardEditorPage', 'DashboardsPage']
  if (pathname === ROUTES.dashboards) return ['DashboardsPage']
  if (pathname.startsWith('/dashboard/')) return ['DashboardEditorPage']
  if (pathname === ROUTES.calendar) return ['CalendarPage']
  if (pathname === ROUTES.lists) return ['ListsLayout']
  if (pathname.startsWith(`${ROUTES.lists}/`)) return ['ListsLayout', 'ListDetailPage']
  if (pathname === ROUTES.notifications) return ['NotificationsPage']
  if (pathname === ROUTES.profile) return ['ProfilePage']
  return []
}

const PRELOAD_CAP_MS = 3000

/**
 * Fetches the chunks for pathname, resolving once they are renderable — or failed, or
 * overran the cap; it never rejects. A chunk that won't load falls back to the lazy
 * path's own error handling, and the cap keeps a stalled fetch from pinning the boot
 * screen past what today's behavior would cost.
 */
export function preloadRouteChunks(pathname: string): Promise<void> {
  const names = chunksForPath(pathname)
  if (names.length === 0) return Promise.resolve()
  const settled = Promise.allSettled(names.map((name) => pages[name].preload()))
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, PRELOAD_CAP_MS)
    void settled.then(() => {
      clearTimeout(cap)
      resolve()
    })
  })
}
