import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { useFleetStore } from '@/store/fleetStore'
import type { FleetSiteInfo } from '@/hooks/useSiteFleetInfo'

/**
 * Fetches fleet metadata for multiple site IDs at once. Returns all rows
 * (a site can have multiple microinverter types → multiple rows).
 */
export function useMultiSiteFleetInfo(siteIds: string[]) {
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)

  const { data, isLoading } = useQuery({
    queryKey: ['fleet-multi-site-lookup', siteIds],
    queryFn: () => {
      if (siteIds.length === 0) return Promise.resolve([])
      const inList = siteIds.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')
      return query<FleetSiteInfo>(`SELECT * FROM fleet WHERE site_id IN (${inList})`)
    },
    enabled: isFleetLoaded && siteIds.length > 0,
    staleTime: Infinity,
  })

  return {
    fleetRows: data ?? [],
    isLoading: isFleetLoaded && isLoading,
  }
}
