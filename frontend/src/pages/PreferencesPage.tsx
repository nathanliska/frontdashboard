import { Home } from 'lucide-react'
import { useAuthStore } from '../stores/auth'

export function PreferencesPage() {
  const user = useAuthStore((s) => s.user)
  const updatePreferences = useAuthStore((s) => s.updatePreferences)
  const homeDashboardId = user?.preferences?.home_dashboard_id ?? null

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="pl-12 sm:pl-0 min-h-10 flex items-center">
        <h1 className="text-xl font-semibold text-zinc-100">Preferences</h1>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-800">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Navigation</p>
        </div>
        <div className="px-5 py-4 flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <Home size={15} className="text-zinc-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-200">Home dashboard</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {homeDashboardId
                  ? 'Set — opening the app goes directly to your home dashboard.'
                  : 'Not set — opening the app shows the dashboards listing.'}
              </p>
            </div>
          </div>
          {homeDashboardId && (
            <button
              onClick={() => void updatePreferences({ home_dashboard_id: null })}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
