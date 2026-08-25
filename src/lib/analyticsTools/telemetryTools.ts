// Telemetry statistics tools — descriptive stats and time-series over the `telemetry` table.
// All metric expressions and dimension names are allowlisted constants.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'

// ─── Allowlisted metric expressions ──────────────────────────────────────────

const TELEMETRY_METRIC_EXPRS: Record<string, string> = {
  energy_produced:  'energy_produced',
  dc_power:         '(dc_current * dc_voltage)',
  ac_power:         '(energy_produced * 3600.0 / NULLIF(duration, 0))',
  temperature_c:    '((temperature_f - 32) * 5.0 / 9.0)',
  temperature_f:    'temperature_f',
  dc_current:       'dc_current',
  dc_voltage:       'dc_voltage',
  ac_voltage:       'ac_voltage',
  ac_frequency:     'ac_frequency',
  duration:         'duration',
}

const TELEMETRY_METRIC_UNITS: Record<string, string> = {
  energy_produced: 'Wh',
  dc_power:        'W',
  ac_power:        'W',
  temperature_c:   '°C',
  temperature_f:   '°F',
  dc_current:      'A',
  dc_voltage:      'V',
  ac_voltage:      'V',
  ac_frequency:    'Hz',
  duration:        's',
}

const MetricSchema = z.enum([
  'energy_produced', 'dc_power', 'ac_power', 'temperature_c', 'temperature_f',
  'dc_current', 'dc_voltage', 'ac_voltage', 'ac_frequency', 'duration',
])

function escapeSql(s: string): string { return s.replace(/'/g, "''") }

function buildSiteFilter(ids?: string[]): string {
  if (!ids?.length) return ''
  return `AND site_id IN (${ids.map((s) => `'${escapeSql(s)}'`).join(', ')})`
}
function buildSerialFilter(ids?: string[]): string {
  if (!ids?.length) return ''
  return `AND serial_number IN (${ids.map((s) => `'${escapeSql(s)}'`).join(', ')})`
}
function buildSkuFilter(ids?: string[]): string {
  if (!ids?.length) return ''
  return `AND sku_name IN (${ids.map((s) => `'${escapeSql(s)}'`).join(', ')})`
}
function buildDateFilter(from?: string, to?: string): string {
  const parts: string[] = []
  if (from) parts.push(`AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)`)
  if (to)   parts.push(`AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)`)
  return parts.join(' ')
}

const TelemetryFiltersSchema = z.object({
  siteIds:  z.array(z.string()).optional(),
  serials:  z.array(z.string()).optional(),
  skuNames: z.array(z.string()).optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
}).optional()

// ─── Tool 1: get_telemetry_statistics ────────────────────────────────────────

const GetTelemetryStatsParams = z.object({
  metric:  MetricSchema,
  groupBy: z.enum(['site_id', 'serial_number', 'sku_name', 'none']).default('site_id'),
  filters: TelemetryFiltersSchema,
  limit:   z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
})
type GetTelemetryStatsParams = z.infer<typeof GetTelemetryStatsParams>

async function executeGetTelemetryStats(params: GetTelemetryStatsParams): Promise<ToolResult> {
  const started = Date.now()
  const f = params.filters ?? {}
  const expr = TELEMETRY_METRIC_EXPRS[params.metric]
  const unit = TELEMETRY_METRIC_UNITS[params.metric]
  const siteF   = buildSiteFilter(f.siteIds)
  const serialF = buildSerialFilter(f.serials)
  const skuF    = buildSkuFilter(f.skuNames)
  const dateF   = buildDateFilter(f.from, f.to)

  const isNone = params.groupBy === 'none'
  const selectGroup = isNone ? '' : `${params.groupBy},`
  const groupClause = isNone ? '' : `GROUP BY ${params.groupBy}`

  const sql = `
    SELECT
      ${selectGroup}
      AVG(${expr})                                              AS avg_${params.metric},
      MIN(${expr})                                              AS min_${params.metric},
      MAX(${expr})                                              AS max_${params.metric},
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${expr})     AS p50_${params.metric},
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${expr})     AS p90_${params.metric},
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${expr})    AS p95_${params.metric},
      COUNT(*)                                                  AS reading_count,
      '${unit}' AS unit
    FROM telemetry
    WHERE ${expr} IS NOT NULL ${siteF} ${serialF} ${skuF} ${dateF}
    ${groupClause}
    ${isNone ? '' : `ORDER BY avg_${params.metric} DESC NULLS LAST`}
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_telemetry_statistics',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getTelemetryStatsTool: AnalyticsTool<GetTelemetryStatsParams> = {
  name: 'get_telemetry_statistics',
  description: 'Descriptive statistics (avg, min, max, p50, p90, p95) for any telemetry metric — energy, DC/AC power, temperature, voltage, current, frequency — grouped by site, inverter, or SKU. Use for "average temperature", "what is the voltage", "power statistics" questions.',
  parametersSchema: GetTelemetryStatsParams,
  execute: executeGetTelemetryStats,
}

// ─── Tool 2: get_time_series ──────────────────────────────────────────────────

const GetTimeSeriesParams = z.object({
  metric:      MetricSchema,
  granularity: z.enum(['5min', '15min', 'hour', 'day', 'week', 'month']).default('hour'),
  filters:     TelemetryFiltersSchema,
  groupBy:     z.enum(['site_id', 'serial_number', 'sku_name', 'none']).default('site_id'),
  limit:       z.number().int().min(1).max(MAX_RESULT_ROWS).default(500),
})
type GetTimeSeriesParams = z.infer<typeof GetTimeSeriesParams>

const GRANULARITY_TRUNC: Record<string, string> = {
  '5min':  `DATE_TRUNC('minute', timestamp) - INTERVAL (MINUTE(timestamp) % 5) MINUTE`,
  '15min': `DATE_TRUNC('minute', timestamp) - INTERVAL (MINUTE(timestamp) % 15) MINUTE`,
  hour:    `DATE_TRUNC('hour', timestamp)`,
  day:     `CAST(timestamp AS DATE)`,
  week:    `DATE_TRUNC('week', timestamp)`,
  month:   `DATE_TRUNC('month', timestamp)`,
}

async function executeGetTimeSeries(params: GetTimeSeriesParams): Promise<ToolResult> {
  const started = Date.now()
  const f = params.filters ?? {}
  const expr = TELEMETRY_METRIC_EXPRS[params.metric]
  const trunc = GRANULARITY_TRUNC[params.granularity]
  const siteF   = buildSiteFilter(f.siteIds)
  const serialF = buildSerialFilter(f.serials)
  const skuF    = buildSkuFilter(f.skuNames)
  const dateF   = buildDateFilter(f.from, f.to)

  const isNone = params.groupBy === 'none'
  const selectGroup = isNone ? '' : `${params.groupBy},`
  const groupClause = isNone
    ? `GROUP BY ${trunc}`
    : `GROUP BY ${trunc}, ${params.groupBy}`

  const sql = `
    SELECT
      CAST(${trunc} AS VARCHAR) AS bucket,
      ${selectGroup}
      AVG(${expr}) AS value,
      COUNT(*)     AS sample_count
    FROM telemetry
    WHERE ${expr} IS NOT NULL ${siteF} ${serialF} ${skuF} ${dateF}
    ${groupClause}
    ORDER BY ${trunc}${isNone ? '' : ', ' + params.groupBy}
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_time_series',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getTimeSeriesParamsTool: AnalyticsTool<GetTimeSeriesParams> = {
  name: 'get_time_series',
  description: 'Hourly/daily/monthly time series for any telemetry metric. Optionally grouped by site or inverter. Use for "show energy over time", "power trend", "how did temperature change", "daily pattern" questions.',
  parametersSchema: GetTimeSeriesParams,
  execute: executeGetTimeSeries,
}

// ─── Tool 3: compare_telemetry ────────────────────────────────────────────────

const CompareTelemetryParams = z.object({
  metric:  MetricSchema,
  groupBy: z.enum(['site_id', 'sku_name', 'serial_number']).default('sku_name'),
  filters: TelemetryFiltersSchema,
  limit:   z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
})
type CompareTelemetryParams = z.infer<typeof CompareTelemetryParams>

async function executeCompareTelemetry(params: CompareTelemetryParams): Promise<ToolResult> {
  const started = Date.now()
  const f = params.filters ?? {}
  const expr = TELEMETRY_METRIC_EXPRS[params.metric]
  const unit = TELEMETRY_METRIC_UNITS[params.metric]
  const siteF   = buildSiteFilter(f.siteIds)
  const serialF = buildSerialFilter(f.serials)
  const skuF    = buildSkuFilter(f.skuNames)
  const dateF   = buildDateFilter(f.from, f.to)

  const sql = `
    SELECT
      ${params.groupBy},
      COUNT(DISTINCT site_id)                                         AS site_count,
      COUNT(DISTINCT serial_number)                                   AS inverter_count,
      AVG(${expr})                                                    AS avg_value,
      MIN(${expr})                                                    AS min_value,
      MAX(${expr})                                                    AS max_value,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${expr})           AS p50_value,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${expr})           AS p90_value,
      COUNT(*)                                                        AS reading_count,
      '${unit}'                                                       AS unit
    FROM telemetry
    WHERE ${expr} IS NOT NULL ${siteF} ${serialF} ${skuF} ${dateF}
    GROUP BY ${params.groupBy}
    ORDER BY avg_value DESC NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'compare_telemetry',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const compareTelemetryTool: AnalyticsTool<CompareTelemetryParams> = {
  name: 'compare_telemetry',
  description: 'Side-by-side comparison of any telemetry metric across different SKU models, sites, or inverters. Returns avg, min, max, p50, p90 per group. Use for "IQ9N vs IQ8HC temperature", "which site has higher DC power", "compare models" questions.',
  parametersSchema: CompareTelemetryParams,
  execute: executeCompareTelemetry,
}

export const TELEMETRY_TOOLS = [
  getTelemetryStatsTool,
  getTimeSeriesParamsTool,
  compareTelemetryTool,
] as const
