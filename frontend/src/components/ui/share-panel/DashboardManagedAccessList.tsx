import { ExternalLink, Users } from 'lucide-react'
import { Link } from 'react-router'
import type { InheritedDashboardAccess } from '../../../api/shares'
import { ROUTES } from '../../../routes'

/**
 * @knipignore Renders the inherited-access ("managed by dashboards") section for a child
 * resource's share panel. Child sharing is dashboard-inherited and the list/event `/shares`
 * endpoints are deliberate 409 stubs, so no screen mounts this yet — intentionally retained
 * scaffolding rather than dead code. See CLAUDE.md "Sharing model".
 */
export function DashboardManagedAccessList({
  dashboards,
  resourceLabel = 'resource',
}: {
  dashboards: InheritedDashboardAccess[]
  resourceLabel?: string
}) {
  if (dashboards.length === 0) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Users size={14} className="text-zinc-500" />
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Managed by dashboards</h3>
          <p className="text-xs text-zinc-500">
            Anyone who can access these dashboards can also access this {resourceLabel}. Change the
            dashboard audience there, or remove the widget from that dashboard.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <ul className="space-y-2">
          {dashboards.map((dashboard) => (
            <li
              key={dashboard.dashboard_id}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{dashboard.dashboard_name}</p>
                  <p className="mt-1 text-xs text-zinc-500">Managed by dashboard</p>
                </div>
                <Link
                  to={ROUTES.dashboard(dashboard.dashboard_id)}
                  className="shrink-0 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Open
                  <ExternalLink size={12} />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
