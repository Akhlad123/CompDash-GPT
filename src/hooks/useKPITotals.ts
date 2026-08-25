import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildKPIQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface KPITotalsRow {
  total_sites: number
  total_inverters: number
  total_energy: number
  date_from: string
  date_to: string
}

export function useKPITotals() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  return useQuery<KPITotalsRow | null>({
    queryKey: ['kpiTotals', dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      const sql = buildKPIQuery(dateRange)
      const rows = await query<KPITotalsRow>(sql)
      return rows[0] ?? null
    },
    enabled: isDataLoaded,
  })
}
