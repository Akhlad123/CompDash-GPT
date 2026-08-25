import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AppMode = 'fleet' | 'telemetry' | 'both' | null

interface AppModeState {
  mode: AppMode
  setMode: (mode: AppMode) => void
}

// Persisted so a full page reload (or session restore) doesn't reset `mode`
// to null and silently hide the Fleet nav section — see AppSidebar's
// showFleet/showTelemetry logic and PageWrapper's SessionRestoreBanner.
export const useAppModeStore = create<AppModeState>()(
  persist(
    (set) => ({
      mode: null,
      setMode: (mode) => set({ mode }),
    }),
    { name: 'compdash_app_mode' }
  )
)
