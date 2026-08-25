import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildAnomalyQuery } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface AnomalyInverterRow {
  serial_number: string
  site_id: string
  sku_name: string | null
  total_energy: number
  site_mean: number
  site_std: number
  z_score: number
}

export type AnomalyStatus = 'normal' | 'warning' | 'alert'

export interface AnomalyInverterWithStatus extends AnomalyInverterRow {
  status: AnomalyStatus
  abs_z: number
  reason: string
}

function safeNum(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmtWh(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + ' MWh'
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1) + ' kWh'
  return v.toFixed(1) + ' Wh'
}

function buildReason(
  energy: number,
  mean: number,
  _std: number,
  _zScore: number,
  absZ: number,
  status: AnomalyStatus
): string {
  if (status === 'normal') return 'Within expected range'

  const diff = energy - mean
  const pctDiff = mean !== 0 ? Math.abs(diff / mean) * 100 : 0
  const direction = diff > 0 ? 'above' : 'below'
  const severity = status === 'alert' ? 'significantly' : 'notably'

  const parts: string[] = []

  parts.push(
    `Energy ${severity} ${direction} site average: ${fmtWh(energy)} vs ${fmtWh(mean)} (${pctDiff.toFixed(1)}% ${direction})`
  )

  parts.push(`Z-score: ${absZ.toFixed(2)}σ from mean`)

  if (diff < 0) {
    if (absZ >= 3) parts.push('Possible inverter failure or extended downtime')
    else if (absZ >= 2) parts.push('Potential underperformance — check for shading, soiling, or partial outage')
    else parts.push('Slight underperformance — may warrant monitoring')
  } else {
    if (absZ >= 3) parts.push('Unusually high output — verify metering accuracy')
    else if (absZ >= 2) parts.push('Higher than expected — check if panel configuration differs')
    else parts.push('Slightly above average — likely within normal variation')
  }

  return parts.join('. ') + '.'
}

function classifyRows(
  rows: AnomalyInverterRow[],
  warnThreshold: number,
  alertThreshold: number
): AnomalyInverterWithStatus[] {
  return rows.map((row) => {
    const energy = safeNum(row.total_energy)
    const mean = safeNum(row.site_mean)
    const std = safeNum(row.site_std)
    const zScore = safeNum(row.z_score)
    const absZ = Math.abs(zScore)

    let status: AnomalyStatus = 'normal'
    if (absZ >= alertThreshold) status = 'alert'
    else if (absZ >= warnThreshold) status = 'warning'

    const reason = buildReason(energy, mean, std, zScore, absZ, status)

    return {
      ...row,
      total_energy: energy,
      site_mean: mean,
      site_std: std,
      z_score: zScore,
      abs_z: absZ,
      status,
      reason,
    }
  })
}

export function useAnomalyData(
  siteIds: string[],
  warnThreshold = 1.5,
  alertThreshold = 2.0
) {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)

  const raw = useQuery<AnomalyInverterRow[]>({
    queryKey: ['anomalyInverters', siteIds],
    queryFn: () => {
      const sql = buildAnomalyQuery(siteIds)
      return query<AnomalyInverterRow>(sql)
    },
    enabled: isDataLoaded && siteIds.length > 0,
  })

  const classified = raw.data
    ? classifyRows(raw.data, warnThreshold, alertThreshold)
    : []

  const alertCount = classified.filter((r) => r.status === 'alert').length
  const warningCount = classified.filter((r) => r.status === 'warning').length
  const normalCount = classified.filter((r) => r.status === 'normal').length

  return {
    data: classified,
    isLoading: raw.isLoading,
    isError: raw.isError,
    alertCount,
    warningCount,
    normalCount,
  }
}
