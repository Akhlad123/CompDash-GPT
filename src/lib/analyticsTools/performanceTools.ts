// Performance analytics tools: clipping, inverter utilization, anomaly detection, microinverter drilldown.
// Clipping uses the existing deterministic detectClippingEvents algorithm.
// Anomaly uses Z-score across inverters within a site (existing useInverterStats pattern).

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import {
  detectClippingEvents,
  DEFAULT_CLIPPING_OPTIONS,
  RATED_AC_POWER_W,
} from '@/lib/clippingAnalysis'
import type { HourlyPoint, ClippingEvent } from '@/lib/clippingAnalysis'
import { buildClippingHourlyQuery } from '@/lib/queries'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'
import { resolveRatedAcPower } from '@/lib/semanticCatalog'

function escapeSql(s: string): string { return s.replace(/'/g, "''") }
function buildSiteFilter(ids?: string[]): string {
  if (!ids?.length) return ''
  return `AND site_id IN (${ids.map((s) => `'${escapeSql(s)}'`).join(', ')})`
}
function buildSerialFilter(ids?: string[]): string {
  if (!ids?.length) return ''
  return `AND serial_number IN (${ids.map((s) => `'${escapeSql(s)}'`).join(', ')})`
}
function buildDateFilter(from?: string, to?: string): string {
  const parts: string[] = []
  if (from) parts.push(`AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)`)
  if (to)   parts.push(`AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)`)
  return parts.join(' ')
}

// ─── Tool 1: calculate_clipping ──────────────────────────────────────────────

const CalculateClippingParams = z.object({
  siteIds:              z.array(z.string()).default([]),
  from:                 z.string().optional(),
  to:                   z.string().optional(),
  isFrance:             z.boolean().default(false),
  minConsecutiveHours:  z.number().int().min(1).max(12).default(2),
  topN:                 z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
})
type CalculateClippingParams = z.infer<typeof CalculateClippingParams>

interface ClippingResultRow {
  site_id: string
  serial_number: string
  sku_name: string | null
  clipping_type: string
  date: string
  start_hour: string
  end_hour: string
  duration_hours: number
  clipped_value: number
  pct_of_rated: number | null
  rated_capacity_w: number | null
}

async function executeCalculateClipping(params: CalculateClippingParams): Promise<ToolResult<ClippingResultRow>> {
  const started = Date.now()
  const dateRange = params.from || params.to
    ? { from: params.from ? new Date(params.from) : new Date('2000-01-01'), to: params.to ? new Date(params.to) : new Date() }
    : undefined

  const sql = buildClippingHourlyQuery(params.siteIds, dateRange)
  const hourlyRows = await query<HourlyPoint>(sql)

  const bySite = new Map<string, HourlyPoint[]>()
  for (const r of hourlyRows) {
    const list = bySite.get(r.site_id)
    if (list) list.push(r)
    else bySite.set(r.site_id, [r])
  }

  const allEvents: ClippingEvent[] = []
  const opts = { ...DEFAULT_CLIPPING_OPTIONS, isFrance: params.isFrance, minConsecutiveHours: params.minConsecutiveHours }
  for (const rows of bySite.values()) {
    allEvents.push(...detectClippingEvents(rows, opts))
  }

  allEvents.sort((a, b) => b.duration_hours - a.duration_hours)

  const rows: ClippingResultRow[] = allEvents.slice(0, params.topN).map((e) => ({
    site_id: e.site_id,
    serial_number: e.serial_number,
    sku_name: e.sku_name,
    clipping_type: e.type,
    date: e.date,
    start_hour: e.start_hour,
    end_hour: e.end_hour,
    duration_hours: e.duration_hours,
    clipped_value: e.clipped_value,
    pct_of_rated: e.pct_of_rated,
    rated_capacity_w: e.rated_capacity,
  }))

  const totalHours = rows.reduce((s, r) => s + r.duration_hours, 0)
  const warning = hourlyRows.length === 0
    ? 'No hourly telemetry data found for the given sites and date range.'
    : undefined

  return {
    rows,
    metadata: {
      tool: 'calculate_clipping',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
      warning: warning ?? (allEvents.length > 0 ? `${allEvents.length} clipping events detected, ${totalHours.toFixed(1)}h total across ${bySite.size} site(s).` : 'No clipping events detected.'),
    },
  }
}

export const calculateClippingTool: AnalyticsTool<CalculateClippingParams, ClippingResultRow> = {
  name: 'calculate_clipping',
  description: 'Detect power and current clipping events for one or more sites using flat-run detection algorithm. Returns per-inverter clipping events with duration, clipped value, and % of rated capacity. Use for "clipping", "inverter limiting", "power capped" questions.',
  parametersSchema: CalculateClippingParams,
  execute: executeCalculateClipping,
}

// ─── Tool 2: calculate_inverter_utilization ────────────────────────────────────

const CalculateUtilizationParams = z.object({
  siteIds:   z.array(z.string()).optional(),
  serials:   z.array(z.string()).optional(),
  from:      z.string().optional(),
  to:        z.string().optional(),
  groupBy:   z.enum(['site_id', 'serial_number', 'sku_name']).default('sku_name'),
  threshold: z.number().min(0).max(1).default(0.9),
  limit:     z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
})
type CalculateUtilizationParams = z.infer<typeof CalculateUtilizationParams>

async function executeCalculateUtilization(params: CalculateUtilizationParams): Promise<ToolResult> {
  const started = Date.now()
  const siteF   = buildSiteFilter(params.siteIds)
  const serialF = buildSerialFilter(params.serials)
  const dateF   = buildDateFilter(params.from, params.to)

  // Build a CASE expression mapping sku_name prefixes to rated power
  // from the known lookup table — avoids joining an external table
  const ratedCases = Object.entries(RATED_AC_POWER_W)
    .sort(([a], [b]) => b.length - a.length)
    .map(([sku, w]) => `WHEN UPPER(sku_name) LIKE '${sku.toUpperCase()}%' THEN ${w}`)
    .join('\n        ')

  const sql = `
    WITH base AS (
      SELECT
        ${params.groupBy},
        (energy_produced * 3600.0 / NULLIF(duration, 0)) AS ac_power_w,
        CASE ${ratedCases} ELSE NULL END AS rated_w
      FROM telemetry
      WHERE duration > 0 AND energy_produced IS NOT NULL ${siteF} ${serialF} ${dateF}
    ),
    util AS (
      SELECT
        ${params.groupBy},
        CASE WHEN rated_w > 0 THEN ac_power_w / rated_w ELSE NULL END AS utilization
      FROM base
      WHERE rated_w IS NOT NULL
    )
    SELECT
      ${params.groupBy},
      AVG(utilization) * 100                                          AS avg_utilization_pct,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY utilization) * 100 AS p50_utilization_pct,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY utilization) * 100 AS p90_utilization_pct,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY utilization) * 100 AS p95_utilization_pct,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY utilization) * 100 AS p99_utilization_pct,
      SUM(CASE WHEN utilization >= ${params.threshold} THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS pct_readings_above_threshold,
      COUNT(*) AS reading_count
    FROM util
    GROUP BY ${params.groupBy}
    ORDER BY avg_utilization_pct DESC NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'calculate_inverter_utilization',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
      warning: rows.length === 0 ? 'No utilization data — SKU names may not match known rated power values.' : undefined,
    },
  }
}

export const calculateUtilizationTool: AnalyticsTool<CalculateUtilizationParams> = {
  name: 'calculate_inverter_utilization',
  description: 'AC power utilization as % of rated capacity per SKU/site/inverter. Returns avg, p50, p90, p95, p99 utilization and % of readings above a threshold. Use for "inverter utilization", "loading", "how loaded is", "operating near rated" questions.',
  parametersSchema: CalculateUtilizationParams,
  execute: executeCalculateUtilization,
}

// ─── Tool 3: detect_anomalies ─────────────────────────────────────────────────

const DetectAnomaliesParams = z.object({
  siteIds:         z.array(z.string()).min(1).max(20),
  from:            z.string().optional(),
  to:              z.string().optional(),
  alertThreshold:  z.number().min(0).default(2.0),
  warningThreshold:z.number().min(0).default(1.5),
  topN:            z.number().int().min(1).max(MAX_RESULT_ROWS).default(50),
})
type DetectAnomaliesParams = z.infer<typeof DetectAnomaliesParams>

async function executeDetectAnomalies(params: DetectAnomaliesParams): Promise<ToolResult> {
  const started = Date.now()
  const siteF = buildSiteFilter(params.siteIds)
  const dateF = buildDateFilter(params.from, params.to)

  const sql = `
    WITH inv AS (
      SELECT serial_number, site_id, sku_name,
             SUM(energy_produced) AS total_energy
      FROM telemetry
      WHERE 1=1 ${siteF} ${dateF}
      GROUP BY serial_number, site_id, sku_name
    ),
    stats AS (
      SELECT site_id,
             AVG(total_energy) AS site_mean,
             COALESCE(STDDEV_POP(total_energy), 0) AS site_std
      FROM inv GROUP BY site_id
    )
    SELECT
      i.serial_number,
      i.site_id,
      i.sku_name,
      i.total_energy / 1000.0 AS total_energy_kwh,
      s.site_mean / 1000.0 AS site_mean_kwh,
      CASE WHEN s.site_std > 0 THEN (i.total_energy - s.site_mean) / s.site_std ELSE 0 END AS z_score,
      CASE
        WHEN s.site_std > 0 AND ABS((i.total_energy - s.site_mean) / s.site_std) >= ${params.alertThreshold} THEN 'alert'
        WHEN s.site_std > 0 AND ABS((i.total_energy - s.site_mean) / s.site_std) >= ${params.warningThreshold} THEN 'warning'
        ELSE 'normal'
      END AS status
    FROM inv i
    JOIN stats s ON i.site_id = s.site_id
    ORDER BY ABS(
      CASE WHEN s.site_std > 0 THEN (i.total_energy - s.site_mean) / s.site_std ELSE 0 END
    ) DESC NULLS LAST
    LIMIT ${params.topN}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'detect_anomalies',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const detectAnomaliesTool: AnalyticsTool<DetectAnomaliesParams> = {
  name: 'detect_anomalies',
  description: 'Z-score anomaly detection for microinverters within a site. Flags inverters as alert (|z|≥2) or warning (|z|≥1.5) based on energy deviation from site mean. Use for "underperforming inverters", "anomalies", "outliers", "which inverters are abnormal" questions.',
  parametersSchema: DetectAnomaliesParams,
  execute: executeDetectAnomalies,
}

// ─── Tool 4: get_inverter_drilldown ──────────────────────────────────────────

const InverterDrilldownParams = z.object({
  serialNumber: z.string().min(1),
  from:         z.string().optional(),
  to:           z.string().optional(),
})
type InverterDrilldownParams = z.infer<typeof InverterDrilldownParams>

async function executeInverterDrilldown(params: InverterDrilldownParams): Promise<ToolResult> {
  const started = Date.now()
  const serialEsc = escapeSql(params.serialNumber)
  const dateF = buildDateFilter(params.from, params.to)

  const sql = `
    SELECT
      serial_number,
      site_id,
      sku_name,
      SUM(energy_produced)            AS total_energy_wh,
      SUM(energy_produced) / 1000.0   AS total_energy_kwh,
      AVG(dc_current * dc_voltage)    AS avg_dc_power_w,
      AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power_w,
      AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temperature_c,
      MAX((temperature_f - 32) * 5.0 / 9.0) AS max_temperature_c,
      AVG(ac_voltage)                 AS avg_ac_voltage_v,
      AVG(dc_voltage)                 AS avg_dc_voltage_v,
      AVG(dc_current)                 AS avg_dc_current_a,
      COUNT(*)                        AS reading_count,
      CAST(MIN(timestamp) AS VARCHAR) AS first_reading,
      CAST(MAX(timestamp) AS VARCHAR) AS last_reading
    FROM telemetry
    WHERE serial_number = '${serialEsc}' ${dateF}
    GROUP BY serial_number, site_id, sku_name
    LIMIT 1
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)

  // Annotate with rated power
  if (rows.length > 0 && typeof rows[0]['sku_name'] === 'string') {
    const rated = resolveRatedAcPower(rows[0]['sku_name'] as string)
    rows[0]['rated_ac_power_w'] = rated
    if (rated && typeof rows[0]['avg_ac_power_w'] === 'number') {
      rows[0]['avg_utilization_pct'] = ((rows[0]['avg_ac_power_w'] as number) / rated) * 100
    }
  }

  return {
    rows,
    metadata: {
      tool: 'get_inverter_drilldown',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const inverterDrilldownTool: AnalyticsTool<InverterDrilldownParams> = {
  name: 'get_inverter_drilldown',
  description: 'Full stats for a single microinverter (serial number): total energy, avg DC/AC power, utilization, temperature, voltages, reading count, date range. Use for "tell me about inverter [SN]", "inverter details", "what is this inverter doing" questions.',
  parametersSchema: InverterDrilldownParams,
  execute: executeInverterDrilldown,
}

export const PERFORMANCE_TOOLS = [
  calculateClippingTool,
  calculateUtilizationTool,
  detectAnomaliesTool,
  inverterDrilldownTool,
] as const
