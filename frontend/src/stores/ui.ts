import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarCollapsed: boolean
  mobileSidebarOpen: boolean
  toggleSidebar: () => void
  toggleMobileSidebar: () => void
  closeMobileSidebar: () => void
}

type PersistedUIState = Pick<UIState, 'sidebarCollapsed'>

export const useUIStore = create<UIState>()(
  persist<UIState, [], [], PersistedUIState>(
    (set) => ({
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleMobileSidebar: () => set((s) => ({ mobileSidebarOpen: !s.mobileSidebarOpen })),
      closeMobileSidebar: () => set({ mobileSidebarOpen: false }),
    }),
    {
      name: 'ui',
      partialize: ({ sidebarCollapsed }) => ({ sidebarCollapsed }),
      // Older persisted state included mobileSidebarOpen. Deliberately merge
      // only the durable preference so an old open overlay cannot reappear.
      merge: (persistedState, currentState) => {
        const persistedSidebar = (persistedState as Partial<PersistedUIState> | undefined)
          ?.sidebarCollapsed
        return {
          ...currentState,
          sidebarCollapsed:
            typeof persistedSidebar === 'boolean'
              ? persistedSidebar
              : currentState.sidebarCollapsed,
        }
      },
    },
  ),
)
