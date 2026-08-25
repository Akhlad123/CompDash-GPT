import { create } from 'zustand'

export interface InverterInfo {
  serial_number: string
  site_id: string
  sku_name: string | null
}

export interface DateRange {
  from: Date
  to: Date
}

interface DataState {
  isDataLoaded: boolean
  sites: string[]
  inverters: InverterInfo[]
  dateRange: DateRange | null
  setDataLoaded: (loaded: boolean) => void
  setSites: (sites: string[]) => void
  setInverters: (inverters: InverterInfo[]) => void
  setDateRange: (range: DateRange | null) => void
  resetData: () => void
}

const initialState = {
  isDataLoaded: false,
  sites: [] as string[],
  inverters: [] as InverterInfo[],
  dateRange: null as DateRange | null,
}

export const useDataStore = create<DataState>((set) => ({
  ...initialState,
  setDataLoaded: (isDataLoaded) => set({ isDataLoaded }),
  setSites: (sites) => set({ sites }),
  setInverters: (inverters) => set({ inverters }),
  setDateRange: (dateRange) => set({ dateRange }),
  resetData: () => set({ ...initialState }),
}))
