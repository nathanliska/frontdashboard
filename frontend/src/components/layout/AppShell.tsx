import { Menu } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSSE } from '../../hooks/useSSE'
import { isConnectionDegraded, useConnectionStore } from '../../stores/connection'
import { useUIStore } from '../../stores/ui'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Toaster } from '../ui/Toaster'
import { ConnectionDot } from './ConnectionDot'
import { Sidebar } from './Sidebar'

export function AppShell({ children }: { children: ReactNode }) {
  useSSE()
  const toggleMobileSidebar = useUIStore((s) => s.toggleMobileSidebar)
  const connectionStatus = useConnectionStore((s) => s.status)
  // The sidebar carries the same dot, but on mobile it lives behind this button — and a phone is
  // where a stream drops most, on backgrounding, screen lock and a wifi handoff.
  const degraded = isConnectionDegraded(connectionStatus)

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100 overflow-hidden">
      <Sidebar />
      <main className="flex-1 h-full overflow-auto p-3 pt-3 sm:p-4 sm:pt-4 lg:p-6">
        <button
          type="button"
          onClick={toggleMobileSidebar}
          className="nav:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300 shadow-lg backdrop-blur"
          aria-label={
            degraded
              ? 'Open navigation (reconnecting — live updates are paused)'
              : 'Open navigation'
          }
        >
          <Menu size={16} />
          <ConnectionDot className="-top-0.5 -right-0.5" />
        </button>
        {children}
      </main>
      <Toaster />
      <ConfirmDialog />
    </div>
  )
}
