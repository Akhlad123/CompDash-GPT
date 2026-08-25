import { create } from 'zustand'
import type { Granularity, MetricKey } from '@/lib/queries'

interface UIState {
  selectedSites: string[]
  selectedInverters: string[]
  granularity: Granularity
  metric: MetricKey
  setSelectedSites: (sites: string[]) => void
  setSelectedInverters: (inverters: string[]) => void
  setGranularity: (granularity: Granularity) => void
  setMetric: (metric: MetricKey) => void
}

export const useUIStore = create<UIState>((set) => ({
  selectedSites: [],
  selectedInverters: [],
  granularity: 'daily',
  metric: 'dc_power',
  setSelectedSites: (selectedSites) => set({ selectedSites }),
  setSelectedInverters: (selectedInverters) => set({ selectedInverters }),
  setGranularity: (granularity) => set({ granularity }),
  setMetric: (metric) => set({ metric }),
}))
