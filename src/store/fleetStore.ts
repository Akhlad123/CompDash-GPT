import { create } from 'zustand'
import type { PowerBinDef } from '@/lib/fleetRegions'

export type FleetAggMode = 'units' | 'sites'

interface FleetState {
  isFleetLoaded: boolean
  isFleetLoading: boolean
  fleetRowCount: number
  fleetLoadError: string | null
  selectedQuarters: string[]
  selectedRegions: string[]
  /** TSS region (EURO/EMKT/LATAM/ANZP/etc.) — cascades to selectedTssCountries. */
  selectedTssRegions: string[]
  /** TSS country/sub-region (e.g. "Belgium", "Rest of EURO") — filtered by selectedTssRegions. */
  selectedTssCountries: string[]
  /** Aggregate wafer/product-bucket calculations by unit count or distinct site count. */
  aggMode: FleetAggMode
  /** Per-region custom power buckets for Wafer Detail (keyed by tss_region code, e.g. 'NA'). Falls back to TSS_REGION_POWER_BINS when absent. */
  customWaferBins: Record<string, PowerBinDef>
  /** Global custom power buckets for Product Bucket page. Falls back to DEFAULT_PRODUCT_POWER_BINS when absent. */
  customProductBins: PowerBinDef | null
  setFleetLoaded: (count: number) => void
  setFleetLoading: (loading: boolean) => void
  setFleetLoadError: (error: string | null) => void
  setSelectedQuarters: (quarters: string[]) => void
  setSelectedRegions: (regions: string[]) => void
  setSelectedTssRegions: (regions: string[]) => void
  setSelectedTssCountries: (countries: string[]) => void
  setAggMode: (mode: FleetAggMode) => void
  setWaferBinsForRegion: (region: string, def: PowerBinDef) => void
  resetWaferBinsForRegion: (region: string) => void
  setProductBins: (def: PowerBinDef) => void
  resetProductBins: () => void
  resetFleet: () => void
}

const initialState = {
  isFleetLoaded: false,
  isFleetLoading: false,
  fleetRowCount: 0,
  fleetLoadError: null as string | null,
  selectedQuarters: [] as string[],
  selectedRegions: [] as string[],
  selectedTssRegions: [] as string[],
  selectedTssCountries: [] as string[],
  aggMode: 'units' as FleetAggMode,
  customWaferBins: {} as Record<string, PowerBinDef>,
  customProductBins: null as PowerBinDef | null,
}

export const useFleetStore = create<FleetState>((set) => ({
  ...initialState,
  setFleetLoaded: (count) => set({ isFleetLoaded: true, isFleetLoading: false, fleetRowCount: count, fleetLoadError: null }),
  setFleetLoading: (loading) => set({ isFleetLoading: loading }),
  setFleetLoadError: (error) => set({ fleetLoadError: error, isFleetLoading: false }),
  setSelectedQuarters: (quarters) => set({ selectedQuarters: quarters }),
  setSelectedRegions: (regions) => set({ selectedRegions: regions }),
  setSelectedTssRegions: (regions) => set({ selectedTssRegions: regions, selectedTssCountries: [] }),
  setSelectedTssCountries: (countries) => set({ selectedTssCountries: countries }),
  setAggMode: (mode) => set({ aggMode: mode }),
  setWaferBinsForRegion: (region, def) =>
    set((s) => ({ customWaferBins: { ...s.customWaferBins, [region]: def } })),
  resetWaferBinsForRegion: (region) =>
    set((s) => {
      const next = { ...s.customWaferBins }
      delete next[region]
      return { customWaferBins: next }
    }),
  setProductBins: (def) => set({ customProductBins: def }),
  resetProductBins: () => set({ customProductBins: null }),
  resetFleet: () => set({ ...initialState }),
}))
