import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildSiteSummaryQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface SiteSummaryRow {
  site_id: string
  inverter_count: number
  total_energy: number
  avg_dc_power: number
  avg_temperature: number
  first_timestamp: string
  last_timestamp: string
  row_count: number
}

export function useSiteStats() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  return useQuery<SiteSummaryRow[]>({
    queryKey: ['siteSummary', dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: () => {
      const sql = buildSiteSummaryQuery(dateRange)
      return query<SiteSummaryRow>(sql)
    },
    enabled: isDataLoaded,
  })
}
