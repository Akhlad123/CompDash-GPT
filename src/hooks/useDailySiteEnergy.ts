import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildDailyEnergyQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface DailySiteEnergyRow {
  site_id: string
  date: string
  daily_energy: number
}

export function useDailySiteEnergy() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  return useQuery<DailySiteEnergyRow[]>({
    queryKey: ['dailySiteEnergy', dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: () => {
      const sql = buildDailyEnergyQuery(dateRange)
      return query<DailySiteEnergyRow>(sql)
    },
    enabled: isDataLoaded,
  })
}
