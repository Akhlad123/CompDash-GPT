// Analyze a single microinverter (serial number) from telemetry data.
// Used by the "Ask me a question" page for questions like "Analyze inverter 123456789012".

import { z } from 'zod'
import { query } from '../duckdb'
import type { AnalyticsTool, ToolResult } from './types'
import { detectClippingEvents, DEFAULT_CLIPPING_OPTIONS, type HourlyPoint } from '../clippingAnalysis'

function escapeSql(s: string): string { return s.replace(/'/g, "''") }
function safe(n: unknown): number { const v = Number(n); return Number.isFinite(v) ? v : 0 }

// ─── Parameters ──────────────────────────────────────────────────────────────

const AnalyzeMicroinverterSchema = z.object({
  serialNumber: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
})

type AnalyzeMicroinverterParams = z.infer<typeof AnalyzeMicroinverterSchema>

// ─── Step helpers ────────────────────────────────────────────────────────────

async function getMicroFleet(serialNumber: string) {
  const sql = `
    SELECT
      site_id, country, tss_region, tss_country, state, city,
      product_type, model_name, sku_name,
      pv_module_make, pv_module_model, stc_rating2, unit_count,
      latitude, longitude
    FROM fleet
    WHERE site_id IN (
      SELECT DISTINCT site_id FROM telemetry WHERE serial_number = '${escapeSql(serialNumber)}'
    )
    LIMIT 1
  `.trim()
  try {
    const rows = await query<Record<string, unknown>>(sql)
    return rows[0] ?? null
  } catch {
    return null
  }
}

async function getMicroOverview(serialNumber: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      serial_number,
      sku_name,
      site_id,
      COUNT(*) AS reading_count,
      COUNT(DISTINCT CAST(timestamp AS DATE)) AS day_count,
      MIN(timestamp) AS first_reading,
      MAX(timestamp) AS last_reading,
      SUM(energy_produced) / 1000.0 AS energy_kwh,
      AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power_w,
      AVG(dc_current * dc_voltage) AS avg_dc_power_w,
      AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temp_c,
      MAX((temperature_f - 32) * 5.0 / 9.0) AS max_temp_c
    FROM telemetry
    WHERE serial_number = '${escapeSql(serialNumber)}' ${dateF}
    GROUP BY serial_number, sku_name, site_id
  `.trim()
  const rows = await query<Record<string, unknown>>(sql)
  return rows[0] ?? null
}

async function getMicroAcPowerStats(serialNumber: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      ROUND(AVG(energy_produced * 3600.0 / NULLIF(duration, 0)), 1) AS avg_ac_power_w,
      MEDIAN(energy_produced * 3600.0 / NULLIF(duration, 0)) AS median_ac_power_w,
      ROUND(MAX(energy_produced * 3600.0 / NULLIF(duration, 0)), 1) AS max_ac_power_w,
      ROUND(MIN(energy_produced * 3600.0 / NULLIF(duration, 0)), 1) AS min_ac_power_w,
      COUNT(*) AS reading_count
    FROM telemetry
    WHERE serial_number = '${escapeSql(serialNumber)}' ${dateF}
      AND duration > 0
  `.trim()
  const rows = await query<Record<string, unknown>>(sql)
  return rows[0] ?? null
}

async function getMicroEnvironment(serialNumber: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      ROUND(AVG(ac_voltage), 1) AS avg_ac_voltage_v,
      ROUND(MEDIAN(ac_voltage), 1) AS median_ac_voltage_v,
      ROUND(MIN(ac_voltage), 1) AS min_ac_voltage_v,
      ROUND(MAX(ac_voltage), 1) AS max_ac_voltage_v,
      ROUND(AVG(ac_frequency), 2) AS avg_ac_frequency_hz,
      ROUND(MEDIAN(ac_frequency), 2) AS median_ac_frequency_hz,
      ROUND(MIN(ac_frequency), 2) AS min_ac_frequency_hz,
      ROUND(MAX(ac_frequency), 2) AS max_ac_frequency_hz,
      ROUND(AVG((temperature_f - 32) * 5.0 / 9.0), 1) AS avg_temp_c,
      ROUND(MEDIAN((temperature_f - 32) * 5.0 / 9.0), 1) AS median_temp_c,
      ROUND(MIN((temperature_f - 32) * 5.0 / 9.0), 1) AS min_temp_c,
      ROUND(MAX((temperature_f - 32) * 5.0 / 9.0), 1) AS max_temp_c,
      COUNT(*) AS reading_count
    FROM telemetry
    WHERE serial_number = '${escapeSql(serialNumber)}' ${dateF}
      AND duration > 0
  `.trim()
  const rows = await query<Record<string, unknown>>(sql)
  return rows[0] ?? null
}

async function getMicroDaily(serialNumber: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      CAST(timestamp AS DATE) AS date,
      SUM(energy_produced) / 1000.0 AS daily_kwh
    FROM telemetry
    WHERE serial_number = '${escapeSql(serialNumber)}' ${dateF}
      AND energy_produced > 0
    GROUP BY date
    ORDER BY date
  `.trim()
  return query<{ date: string; daily_kwh: number }>(sql)
}

async function detectMicroClipping(serialNumber: string, dateRange?: { from?: string; to?: string }) {
  try {
    const dr =
      dateRange?.from && dateRange?.to
        ? { from: new Date(dateRange.from), to: new Date(dateRange.to) }
        : null
    const hourlyRows = await query<HourlyPoint>(buildClippingHourlyQuerySerial(serialNumber, dr))
    if (!hourlyRows || hourlyRows.length === 0) return { events: [], classification: 'none' }
    const events = detectClippingEvents(hourlyRows, DEFAULT_CLIPPING_OPTIONS)
    return {
      events: events.slice(0, 20),
      total_event_count: events.length,
      classification: events.length === 0 ? 'none' : events.length <= 5 ? 'minor' : events.length <= 20 ? 'moderate' : 'significant',
    }
  } catch {
    return { events: [], classification: 'none' }
  }
}

function buildClippingHourlyQuerySerial(serialNumber: string, dr: { from: Date; to: Date } | null): string {
  const dateF = [
    dr ? `AND timestamp >= CAST('${escapeSql(dr.from.toISOString().split('T')[0])}' AS TIMESTAMP)` : '',
    dr ? `AND timestamp <= CAST('${escapeSql(dr.to.toISOString().split('T')[0])}' AS TIMESTAMP)` : '',
  ].join(' ')

  return `
    SELECT
      serial_number,
      MAX(sku_name) AS sku_name,
      CAST(timestamp AS DATE) AS date,
      EXTRACT(HOUR FROM timestamp) AS hour_of_day,
      AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power_w,
      MAX((temperature_f - 32) * 5.0 / 9.0) AS max_temp_c,
      AVG(ac_voltage) AS avg_ac_voltage_v,
      AVG(dc_current) AS avg_dc_current_a
    FROM telemetry
    WHERE serial_number = '${escapeSql(serialNumber)}' ${dateF}
    GROUP BY serial_number, date, hour_of_day
    ORDER BY date, hour_of_day
  `.trim()
}

// ─── Main execution ──────────────────────────────────────────────────────────

async function executeAnalyzeMicroinverter(params: AnalyzeMicroinverterParams): Promise<ToolResult> {
  const started = Date.now()
  const { serialNumber, from, to } = params

  const result: Record<string, unknown> = {
    serial_number: serialNumber,
    _analysis_type: 'microinverter_analysis',
  }

  const overview = await getMicroOverview(serialNumber, from, to)
  if (!overview) {
    return {
      rows: [{ ...result, telemetry_note: `No telemetry found for serial ${serialNumber}.` }],
      metadata: {
        tool: 'analyze_microinverter',
        params: { serialNumber, from, to },
        executionMs: Date.now() - started,
        rowCount: 1,
      },
    }
  }

  result.overview = overview
  result.site_id = overview['site_id']

  const [acPower, environment, daily, clipping, fleet] = await Promise.all([
    getMicroAcPowerStats(serialNumber, from, to),
    getMicroEnvironment(serialNumber, from, to),
    getMicroDaily(serialNumber, from, to),
    detectMicroClipping(serialNumber, { from, to }),
    getMicroFleet(serialNumber),
  ])

  if (acPower) result.ac_power = acPower
  if (environment) result.environment = environment
  if (fleet) result.fleet_summary = fleet

  if (daily.length > 0) {
    const values = daily.map((d) => safe(d.daily_kwh))
    const avg = values.reduce((a, b) => a + b, 0) / values.length
    const sorted = [...values].sort((a, b) => a - b)
    const n = sorted.length
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
    result.daily_production = {
      days: n,
      avg_daily_kwh: Math.round(avg * 100) / 100,
      median_daily_kwh: Math.round(median * 100) / 100,
      min_daily_kwh: Math.round(sorted[0] * 100) / 100,
      max_daily_kwh: Math.round(sorted[sorted.length - 1] * 100) / 100,
    }
  }

  result.clipping = clipping

  return {
    rows: [result],
    metadata: {
      tool: 'analyze_microinverter',
      params: { serialNumber, from, to },
      executionMs: Date.now() - started,
      rowCount: 1,
    },
  }
}

// ─── Exported tool ───────────────────────────────────────────────────────────

export const analyzeMicroinverterTool: AnalyticsTool<AnalyzeMicroinverterParams, Record<string, unknown>> = {
  name: 'analyze_microinverter',
  description: 'Run a comprehensive telemetry-only analysis for a single microinverter serial number: production, AC power statistics, AC voltage / frequency / temperature summary, clipping detection, and site context.',
  parametersSchema: AnalyzeMicroinverterSchema,
  execute: executeAnalyzeMicroinverter,
}
