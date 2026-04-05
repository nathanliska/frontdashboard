import type { ReactNode } from 'react'
import { Menu } from 'lucide-react'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Toaster } from '../ui/Toaster'
import { useSSE } from '../../hooks/useSSE'
import { useUIStore } from '../../stores/ui'
import { Sidebar } from './Sidebar'

export function AppShell({ children }: { children: ReactNode }) {
  useSSE()
  const toggleMobileSidebar = useUIStore((s) => s.toggleMobileSidebar)

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-auto p-3 pt-3 sm:p-4 sm:pt-4 lg:p-6">
        <button
          type="button"
          onClick={toggleMobileSidebar}
          className="sm:hidden fixed top-3 left-3 z-30 inline-flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/90 p-2 text-zinc-300 shadow-lg backdrop-blur"
          aria-label="Open navigation"
        >
          <Menu size={16} />
        </button>
        {children}
      </main>
      <Toaster />
      <ConfirmDialog />
    </div>
  )
}
