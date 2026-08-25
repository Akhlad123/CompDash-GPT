import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildClippingHourlyQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'
import {
  detectClippingEvents,
  DEFAULT_CLIPPING_OPTIONS,
} from '@/lib/clippingAnalysis'
import type { ClippingEvent, ClippingOptions, HourlyPoint } from '@/lib/clippingAnalysis'
import type { FleetSiteInfo } from '@/hooks/useSiteFleetInfo'

/**
 * Fetches hourly AC power / DC current series for the given sites (respecting
 * the global date range) and runs the clipping-detection algorithm client
 * side. The hourly aggregation happens in DuckDB (cheap, columnar); the
 * flat-run scan happens in JS since it's a small, already-reduced dataset.
 *
 * Optionally accepts a `fleetRows` array so the algorithm can auto-detect
 * France sites and apply the 94% power factor restriction.
 */
export function useClippingAnalysis(
  siteIds: string[],
  options: ClippingOptions = DEFAULT_CLIPPING_OPTIONS,
  fleetRows: FleetSiteInfo[] = []
) {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  const { data: hourlyRows, isLoading, error } = useQuery({
    queryKey: [
      'clipping-hourly',
      siteIds,
      dateRange?.from?.toISOString(),
      dateRange?.to?.toISOString(),
    ],
    queryFn: () => query<HourlyPoint>(buildClippingHourlyQuery(siteIds, dateRange)),
    enabled: isDataLoaded,
  })

  // Build a set of France site IDs from fleet data
  const franceSiteIds = useMemo(() => {
    const set = new Set<string>()
    for (const r of fleetRows) {
      if (r.country?.toLowerCase() === 'france') set.add(r.site_id)
    }
    return set
  }, [fleetRows])

  const events = useMemo<ClippingEvent[]>(() => {
    if (!hourlyRows || hourlyRows.length === 0) return []
    // Group rows by site and detect per-site with France flag
    const bySite = new Map<string, HourlyPoint[]>()
    for (const r of hourlyRows) {
      const list = bySite.get(r.site_id)
      if (list) list.push(r)
      else bySite.set(r.site_id, [r])
    }
    const allEvents: ClippingEvent[] = []
    for (const [siteId, rows] of bySite) {
      const siteOpts = { ...options, isFrance: franceSiteIds.has(siteId) }
      allEvents.push(...detectClippingEvents(rows, siteOpts))
    }
    allEvents.sort((a, b) => b.duration_hours - a.duration_hours)
    return allEvents
  }, [hourlyRows, options, franceSiteIds])

  return {
    hourlyRows: hourlyRows ?? [],
    events,
    isLoading,
    error,
  }
}
