import type { DashboardSummary } from '../../api/dashboards'

/** The dashboard picker a page header carries; `null` is the placeholder row. */
export function DashboardSelect({
  value,
  dashboards,
  disabled,
  onChange,
}: {
  value: string | null
  dashboards: DashboardSummary[]
  disabled: boolean
  onChange: (dashboardId: string | null) => void
}) {
  return (
    <select
      name="dashboard"
      // Without the label the accessible name is the selected option, so a screen reader announces
      // the dashboard's name rather than what the control does.
      aria-label="Dashboard"
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      className="min-w-0 max-w-44 sm:max-w-none flex-1 lg:flex-none rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-700 disabled:text-zinc-600"
    >
      <option value="">Select dashboard</option>
      {dashboards.map((dashboard) => (
        <option key={dashboard.id} value={dashboard.id}>
          {dashboard.name}
        </option>
      ))}
    </select>
  )
}
