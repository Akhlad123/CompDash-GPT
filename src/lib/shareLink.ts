import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string'
import { useUIStore } from '@/store/uiStore'
import { useDataStore } from '@/store/dataStore'
import type { MetricKey, Granularity } from '@/lib/queries'

export interface ShareState {
  view: string
  sites: string[]
  inverters: string[]
  metric: string
  granularity: string
  dateRange: { from: string; to: string } | null
  threshold?: number
}

export function encodeState(state: ShareState): string {
  const json = JSON.stringify(state)
  return compressToEncodedURIComponent(json)
}

export function decodeState(encoded: string): ShareState | null {
  try {
    const json = decompressFromEncodedURIComponent(encoded)
    if (!json) return null
    return JSON.parse(json) as ShareState
  } catch {
    return null
  }
}

export function getShareURL(): string {
  const uiState = useUIStore.getState()
  const dataState = useDataStore.getState()

  const hash = window.location.hash.split('?')[0].replace('#', '')
  const view = hash.startsWith('/') ? hash : `/${hash}`

  const state: ShareState = {
    view,
    sites: uiState.selectedSites,
    inverters: uiState.selectedInverters,
    metric: uiState.metric,
    granularity: uiState.granularity,
    dateRange: dataState.dateRange
      ? {
          from: dataState.dateRange.from.toISOString(),
          to: dataState.dateRange.to.toISOString(),
        }
      : null,
  }

  const encoded = encodeState(state)
  const base = window.location.href.split('#')[0]
  return `${base}#${view}?state=${encoded}`
}

export function applyStateFromURL(): ShareState | null {
  const hash = window.location.hash
  const stateMatch = hash.match(/[?&]state=([^&]+)/)
  if (!stateMatch) return null

  const state = decodeState(stateMatch[1])
  if (!state) return null

  const ui = useUIStore.getState()
  if (state.sites.length > 0) ui.setSelectedSites(state.sites)
  if (state.inverters.length > 0) ui.setSelectedInverters(state.inverters)
  if (state.metric) ui.setMetric(state.metric as MetricKey)
  if (state.granularity) ui.setGranularity(state.granularity as Granularity)

  if (state.dateRange) {
    const parseLocal = (s: string) => {
      const parts = s.slice(0, 10).split('-').map(Number)
      return new Date(parts[0], parts[1] - 1, parts[2])
    }
    const dataStore = useDataStore.getState()
    dataStore.setDateRange({
      from: parseLocal(state.dateRange.from),
      to: parseLocal(state.dateRange.to),
    })
  }

  return state
}
