import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildInverterSummaryQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface InverterStatsRow {
  serial_number: string
  site_id: string
  sku_name: string | null
  total_energy: number
  avg_dc_power: number
  avg_temperature: number
  first_timestamp: string
  last_timestamp: string
  row_count: number
}

export type InverterStatus = 'normal' | 'warning' | 'alert'

export interface InverterStatsWithZ extends InverterStatsRow {
  z_score: number
  status: InverterStatus
  reason: string
}

function safeNum(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmtWh(v: number): string {
  const kwh = v / 1000
  if (Math.abs(kwh) >= 1_000) return (kwh / 1_000).toFixed(2) + ' MWh'
  return kwh.toFixed(1) + ' kWh'
}

function computeZScores(rows: InverterStatsRow[]): InverterStatsWithZ[] {
  if (rows.length === 0) return []

  const energies = rows.map((r) => safeNum(r.total_energy))
  const mean = energies.reduce((a, b) => a + b, 0) / energies.length
  const variance =
    energies.reduce((a, v) => a + (v - mean) ** 2, 0) / energies.length
  const stdDev = Math.sqrt(variance)

  return rows.map((row) => {
    const energy = safeNum(row.total_energy)
    const z = stdDev > 0 ? Math.abs((energy - mean) / stdDev) : 0
    let status: InverterStatus = 'normal'
    if (z > 2) status = 'alert'
    else if (z > 1.5) status = 'warning'

    let reason = ''
    if (status !== 'normal') {
      const diff = energy - mean
      const direction = diff > 0 ? 'above' : 'below'
      const pctDiff = mean !== 0 ? Math.abs(diff / mean) * 100 : 0
      const severity = status === 'alert' ? 'significantly' : 'notably'
      reason = `Energy ${severity} ${direction} site average: ${fmtWh(energy)} vs ${fmtWh(mean)} (${pctDiff.toFixed(1)}% ${direction}). Z-score: ${z.toFixed(2)}σ.`
      if (diff < 0) {
        reason += z >= 2 ? ' Potential underperformance — check for shading, soiling, or outage.' : ' Slight underperformance — may warrant monitoring.'
      } else {
        reason += z >= 2 ? ' Unusually high output — verify metering accuracy.' : ' Higher than expected — check panel configuration.'
      }
    }

    return { ...row, z_score: z, status, reason }
  })
}

export function useInverterStats(siteId: string) {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  return useQuery<InverterStatsWithZ[]>({
    queryKey: ['inverterStats', siteId, dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      const sql = buildInverterSummaryQuery(siteId, dateRange)
      console.log('[useInverterStats] SQL:', sql)
      const rows = await query<InverterStatsRow>(sql)
      console.log('[useInverterStats] results:', rows.length, 'rows, sample:', rows[0] ? JSON.stringify({ sn: rows[0].serial_number, total_energy: rows[0].total_energy, row_count: rows[0].row_count }) : 'none')
      return computeZScores(rows)
    },
    enabled: isDataLoaded && siteId.length > 0,
  })
}
