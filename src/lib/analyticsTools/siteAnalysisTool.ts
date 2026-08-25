// Multi-step "Analyze Site" workflow tool.
// Fleet lookup → peer discovery → telemetry check → energy + daily trends →
// proper clipping → anomalies → peer telemetry → peer benchmarking → structured output.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import { ensureRmaDataLoaded } from '@/lib/rmaDuckdb'
import { buildClippingHourlyQuery } from '@/lib/queries'
import {
  detectClippingEvents,
  DEFAULT_CLIPPING_OPTIONS,
} from '@/lib/clippingAnalysis'
import type { HourlyPoint, ClippingEvent } from '@/lib/clippingAnalysis'
import { findSimilarSites, DEFAULT_SIMILARITY_CONFIG } from '@/lib/peerDiscovery'
import type { FleetRow } from '@/lib/peerDiscovery'
import type { AnalyticsTool, ToolResult } from './types'

function escapeSql(s: string): string { return s.replace(/'/g, "''") }
function safe(n: unknown): number { const v = Number(n); return Number.isFinite(v) ? v : 0 }

// ─── Parameters ──────────────────────────────────────────────────────────────

const AnalyzeSiteParams = z.object({
  siteId:            z.string().min(1),
  from:              z.string().optional(),
  to:                z.string().optional(),
  requireModuleInfo: z.boolean().optional(),  // default true — only show peers with module data
})
type AnalyzeSiteParams = z.infer<typeof AnalyzeSiteParams>

// ─── Clipping classification thresholds (configurable — not set by LLM) ──────

const CLIPPING_THRESHOLDS = { minor: 5, moderate: 20 } // event counts

function classifyClipping(count: number): string {
  if (count === 0) return 'none'
  if (count <= CLIPPING_THRESHOLDS.minor) return 'minor'
  if (count <= CLIPPING_THRESHOLDS.moderate) return 'moderate'
  return 'significant'
}

// ─── Grid profile inference ──────────────────────────────────────────────────

function inferGridProfile(
  country: string | null,
  state: string | null,
  circuitPhase: string | null,
  productionEim: string | null,
): { voltage_v: number; frequency_hz: number; phase: string; note: string } {
  const c = String(country ?? '').toLowerCase().trim()
  const s = String(state ?? '').toLowerCase().trim()
  const phase = String(circuitPhase ?? '').trim() || 'Unknown'
  const eim = String(productionEim ?? '').trim() || 'Unknown'

  // Default to the most common global grid standard
  let voltage_v = 230
  let frequency_hz = 50

  // North America / parts of LATAM / some Caribbean/Japan
  if (['united states', 'usa', 'canada', 'mexico', 'brazil', 'philippines', 'taiwan'].includes(c)) {
    voltage_v = ['japan'].includes(c) ? 100 : 120
    frequency_hz = c === 'brazil' ? 60 : (c === 'japan' ? (['hokkaido', 'aomori', 'iwate'].includes(s) ? 50 : 60) : 60)
  }
  // Australia / NZ split phase 230/400, 50 Hz
  if (['australia', 'new zealand'].includes(c)) {
    voltage_v = 230
    frequency_hz = 50
  }
  // India nominal 230/240
  if (['india'].includes(c)) {
    voltage_v = 230
    frequency_hz = 50
  }
  // Europe, UK, most of Asia/Africa
  if (['france', 'germany', 'italy', 'spain', 'netherlands', 'belgium', 'portugal', 'uk', 'united kingdom', 'ireland', 'south africa'].includes(c)) {
    voltage_v = 230
    frequency_hz = 50
  }

  const phaseLabel = phase || (eim.toLowerCase().includes('three') ? 'Three-phase' : 'Single-phase')
  const note = `Inferred ${voltage_v}V / ${frequency_hz}Hz from ${country || 'location'}${phaseLabel ? ` (${phaseLabel})` : ''}`
  return { voltage_v, frequency_hz, phase: phaseLabel, note }
}

// ─── Step helpers ────────────────────────────────────────────────────────────

/** Step 1: Fleet metadata for the site (target) */
async function getFleetInfo(siteId: string) {
  const sql = `
    SELECT
      site_id, country, tss_region, tss_country, region_bundle,
      product_type, device_type_name, pv_module_make, pv_module_model,
      module_wafer, stc_rating2, stc_mwdc, mwac, dc_ac_ratio,
      unit_count, power_bucket, quarter_first_interval,
      city, state, zip_code, latitude, longitude,
      irr_ann_kwh_m2_month, voc, isc, model_name,
      circuit_phase, production_eim_config, consumption_eim_config
    FROM fleet
    WHERE site_id = '${escapeSql(siteId)}'
    LIMIT 20
  `.trim()
  return query<Record<string, unknown>>(sql)
}

/** Fetch fleet roster for peer discovery (excludes target, requires lat/lon) */
async function getFleetRoster(excludeSiteId: string): Promise<FleetRow[]> {
  const sql = `
    SELECT site_id, latitude, longitude, pv_module_model, stc_rating2,
           module_wafer, product_type, model_name, unit_count, dc_ac_ratio,
           country, tss_region, city, state, quarter_first_interval, pv_module_make,
           irr_ann_kwh_m2_month
    FROM fleet
    WHERE site_id != '${escapeSql(excludeSiteId)}'
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    LIMIT 8000
  `.trim()
  return query<FleetRow>(sql)
}

/** Step 2: Check if telemetry data exists for this site */
async function checkTelemetry(siteId: string) {
  const sql = `
    SELECT
      COUNT(DISTINCT serial_number)  AS micro_count,
      COUNT(*)                       AS reading_count,
      COUNT(DISTINCT sku_name)       AS sku_count,
      CAST(MIN(timestamp) AS VARCHAR) AS first_reading,
      CAST(MAX(timestamp) AS VARCHAR) AS last_reading,
      COUNT(DISTINCT CAST(timestamp AS DATE)) AS day_count
    FROM telemetry
    WHERE site_id = '${escapeSql(siteId)}'
  `.trim()
  return query<Record<string, unknown>>(sql)
}

/** Step 3: Site-level energy + daily breakdown */
async function getSiteEnergy(siteId: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const aggregateSql = `
    SELECT
      site_id,
      SUM(energy_produced) / 1000.0  AS total_energy_kwh,
      SUM(energy_produced) / 1e6     AS total_energy_mwh,
      COUNT(DISTINCT serial_number)  AS inverter_count,
      COUNT(*)                       AS reading_count,
      AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power_w,
      AVG(dc_current * dc_voltage)   AS avg_dc_power_w,
      AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temperature_c,
      MAX((temperature_f - 32) * 5.0 / 9.0) AS max_temperature_c,
      AVG(ac_voltage)                AS avg_ac_voltage_v,
      AVG(dc_voltage)                AS avg_dc_voltage_v
    FROM telemetry
    WHERE site_id = '${escapeSql(siteId)}' ${dateF}
    GROUP BY site_id
  `.trim()

  const dailySql = `
    SELECT
      CAST(timestamp AS DATE) AS date,
      SUM(energy_produced) / 1000.0 AS daily_kwh
    FROM telemetry
    WHERE site_id = '${escapeSql(siteId)}' ${dateF}
      AND energy_produced > 0
    GROUP BY date
    ORDER BY date
  `.trim()

  const [aggregate, daily] = await Promise.all([
    query<Record<string, unknown>>(aggregateSql),
    query<{ date: string; daily_kwh: number }>(dailySql),
  ])
  return { aggregate, daily }
}

/** Compute daily production trend from daily rows */
function computeTrend(daily: { date: string; daily_kwh: number }[]): {
  avg_daily_kwh: number
  median_daily_kwh: number
  min_daily_kwh: number
  max_daily_kwh: number
  trend: string
  valid_days: number
} {
  if (daily.length === 0) {
    return { avg_daily_kwh: 0, median_daily_kwh: 0, min_daily_kwh: 0, max_daily_kwh: 0, trend: 'insufficient_data', valid_days: 0 }
  }
  const vals = daily.map((d) => safe(d.daily_kwh))
  const n = vals.length
  const avg = vals.reduce((a, b) => a + b, 0) / n
  const sorted = [...vals].sort((a, b) => a - b)
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
  const min = sorted[0]
  const max = sorted[n - 1]

  let trend = 'stable'
  if (n >= 7) {
    // Simple linear regression slope (fraction of mean per week)
    const xMean = (n - 1) / 2
    let num = 0, den = 0
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (vals[i] - avg)
      den += (i - xMean) ** 2
    }
    const slope = den > 0 ? num / den : 0
    const cv = avg > 0 ? Math.sqrt(vals.reduce((s, v) => s + (v - avg) ** 2, 0) / n) / avg : 0
    if (cv > 0.4) trend = 'highly_variable'
    else if (slope / avg > 0.02 / 7) trend = 'increasing'
    else if (slope / avg < -0.02 / 7) trend = 'decreasing'
    else trend = 'stable'
  } else if (n < 3) {
    trend = 'insufficient_data'
  }

  return {
    avg_daily_kwh: Math.round(avg * 100) / 100,
    median_daily_kwh: Math.round(median * 100) / 100,
    min_daily_kwh: Math.round(min * 100) / 100,
    max_daily_kwh: Math.round(max * 100) / 100,
    trend,
    valid_days: n,
  }
}

/** Step 4a: Per-microinverter energy breakdown (top & bottom performers) */
async function getPerInverterEnergy(siteId: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      serial_number,
      sku_name,
      SUM(energy_produced) / 1000.0  AS energy_kwh,
      COUNT(*)                       AS reading_count,
      AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power_w,
      AVG(dc_current * dc_voltage)   AS avg_dc_power_w,
      AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temp_c,
      MAX((temperature_f - 32) * 5.0 / 9.0) AS max_temp_c,
      AVG(dc_voltage)                AS avg_dc_voltage_v,
      AVG(dc_current)                AS avg_dc_current_a
    FROM telemetry
    WHERE site_id = '${escapeSql(siteId)}' ${dateF}
    GROUP BY serial_number, sku_name
    ORDER BY energy_kwh DESC NULLS LAST
    LIMIT 100
  `.trim()
  return query<Record<string, unknown>>(sql)
}

/** Step 4b: Detailed per-microinverter AC power statistics (max / median / avg) */
async function getPerInverterAcPowerStats(siteId: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    WITH ac AS (
      SELECT
        serial_number,
        sku_name,
        energy_produced * 3600.0 / NULLIF(duration, 0) AS ac_power_w
      FROM telemetry
      WHERE site_id = '${escapeSql(siteId)}' ${dateF}
        AND duration > 0
        AND energy_produced > 0
    )
    SELECT
      serial_number,
      sku_name,
      ROUND(AVG(ac_power_w), 1)   AS avg_ac_power_w,
      MEDIAN(ac_power_w)          AS median_ac_power_w,
      ROUND(MAX(ac_power_w), 1)   AS max_ac_power_w,
      ROUND(MIN(ac_power_w), 1)   AS min_ac_power_w,
      COUNT(*)                    AS reading_count
    FROM ac
    GROUP BY serial_number, sku_name
    ORDER BY max_ac_power_w DESC NULLS LAST
    LIMIT 100
  `.trim()
  return query<Record<string, unknown>>(sql)
}

/** Step 4c: Per-microinverter AC voltage, AC frequency, and temperature summary */
async function getPerInverterEnvironment(siteId: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      serial_number,
      sku_name,
      ROUND(AVG(ac_voltage), 1)                   AS avg_ac_voltage_v,
      ROUND(MEDIAN(ac_voltage), 1)                AS median_ac_voltage_v,
      ROUND(MIN(ac_voltage), 1)                   AS min_ac_voltage_v,
      ROUND(MAX(ac_voltage), 1)                   AS max_ac_voltage_v,
      ROUND(AVG(ac_frequency), 2)                 AS avg_ac_frequency_hz,
      ROUND(MEDIAN(ac_frequency), 2)              AS median_ac_frequency_hz,
      ROUND(MIN(ac_frequency), 2)                 AS min_ac_frequency_hz,
      ROUND(MAX(ac_frequency), 2)                 AS max_ac_frequency_hz,
      ROUND(AVG((temperature_f - 32) * 5.0 / 9.0), 1) AS avg_temp_c,
      ROUND(MEDIAN((temperature_f - 32) * 5.0 / 9.0), 1) AS median_temp_c,
      ROUND(MIN((temperature_f - 32) * 5.0 / 9.0), 1) AS min_temp_c,
      ROUND(MAX((temperature_f - 32) * 5.0 / 9.0), 1) AS max_temp_c,
      COUNT(*)                                    AS reading_count
    FROM telemetry
    WHERE site_id = '${escapeSql(siteId)}' ${dateF}
      AND duration > 0
    GROUP BY serial_number, sku_name
    ORDER BY serial_number
    LIMIT 100
  `.trim()
  return query<Record<string, unknown>>(sql)
}

/** Step 5: Anomaly detection (Z-score) */
async function detectAnomalies(siteId: string, from?: string, to?: string) {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    WITH inv AS (
      SELECT serial_number, sku_name,
             SUM(energy_produced) AS total_energy,
             COUNT(*)             AS reading_count,
             AVG(energy_produced * 3600.0 / NULLIF(duration, 0)) AS avg_ac_power
      FROM telemetry
      WHERE site_id = '${escapeSql(siteId)}' ${dateF}
      GROUP BY serial_number, sku_name
    ),
    stats AS (
      SELECT AVG(total_energy) AS site_mean,
             COALESCE(STDDEV_POP(total_energy), 0) AS site_std
      FROM inv
    )
    SELECT
      i.serial_number,
      i.sku_name,
      i.total_energy / 1000.0         AS energy_kwh,
      i.avg_ac_power                  AS avg_ac_power_w,
      s.site_mean / 1000.0            AS site_mean_kwh,
      CASE WHEN s.site_std > 0 THEN (i.total_energy - s.site_mean) / s.site_std ELSE 0 END AS z_score,
      CASE
        WHEN s.site_std > 0 AND ABS((i.total_energy - s.site_mean) / s.site_std) >= 2.0 THEN 'alert'
        WHEN s.site_std > 0 AND ABS((i.total_energy - s.site_mean) / s.site_std) >= 1.5 THEN 'warning'
        ELSE 'normal'
      END AS status
    FROM inv i CROSS JOIN stats s
    ORDER BY ABS(CASE WHEN s.site_std > 0 THEN (i.total_energy - s.site_mean) / s.site_std ELSE 0 END) DESC
    LIMIT 50
  `.trim()
  return query<Record<string, unknown>>(sql)
}

// ─── Clipping reason analysis (post-process events) ─────────────────────────

/**
 * Post-processes raw ClippingEvent[] to explain WHY clipping is occurring.
 * Checks clipping current consistency and whether power clipping is at rated AC capacity.
 */
function analyzeClippingReasons(events: ClippingEvent[]): Record<string, unknown> | null {
  const powerEvents = events.filter((e) => e.type === 'power')
  const currentEvents = events.filter((e) => e.type === 'current')
  const reasons: Record<string, unknown> = {}

  if (currentEvents.length > 0) {
    const vals = currentEvents.map((e) => e.clipped_value)
    const avgA = vals.reduce((a, b) => a + b, 0) / vals.length
    const minA = Math.min(...vals)
    const maxA = Math.max(...vals)
    const variation = maxA - minA
    const isConsistent = variation <= 0.5

    // Per-day breakdown
    const byDate: Record<string, number[]> = {}
    for (const e of currentEvents) {
      ;(byDate[e.date] ??= []).push(e.clipped_value)
    }
    const perDay = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        avg_current_a: Math.round(v.reduce((s, x) => s + x, 0) / v.length * 100) / 100,
      }))

    reasons.current_clipping = {
      characteristic_current_a: Math.round(avgA * 100) / 100,
      min_clipped_a: Math.round(minA * 100) / 100,
      max_clipped_a: Math.round(maxA * 100) / 100,
      variation_a: Math.round(variation * 100) / 100,
      is_consistent: isConsistent,
      consistency_flag: !isConsistent
        ? `Current clipping varies ${variation.toFixed(2)} A across events — may indicate multiple module configurations, partial shading, or degradation`
        : null,
      per_day: perDay.slice(0, 10),
    }
  }

  if (powerEvents.length > 0) {
    const vals = powerEvents.map((e) => e.clipped_value)
    const avgW = vals.reduce((a, b) => a + b, 0) / vals.length
    const firstWithRating = powerEvents.find((e) => e.rated_capacity != null)
    const ratedW = firstWithRating?.rated_capacity ?? null
    const isAtRated = ratedW != null && avgW >= ratedW * 0.95
    const isBelowRated = ratedW != null && avgW < ratedW * 0.95

    reasons.power_clipping = {
      characteristic_power_w: Math.round(avgW * 100) / 100,
      rated_ac_capacity_w: ratedW,
      pct_of_rated: ratedW != null ? Math.round((avgW / ratedW) * 1000) / 10 : null,
      is_at_rated_capacity: isAtRated,
      assessment: isAtRated
        ? `Expected — clipping at rated AC output (~${Math.round(avgW)} W). Normal during high irradiance.`
        : isBelowRated && ratedW != null
          ? `Unexpected — clipping at ~${Math.round(avgW)} W, below rated ${ratedW} W. Possible thermal derating, firmware cap, or hardware fault.`
          : 'Power clipping detected (rated AC capacity unknown for this SKU)',
    }
  }

  return Object.keys(reasons).length > 0 ? reasons : null
}

// ─── Per-inverter mismatch detection ─────────────────────────────────────────

/** Detects >20% deviation in avg AC power, DC current, or DC voltage across inverters of the same site. */
async function detectInverterMismatch(siteId: string, from?: string, to?: string): Promise<Record<string, unknown>> {
  const dateF = [
    from ? `AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)` : '',
    to   ? `AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    WITH inv AS (
      SELECT
        serial_number,
        sku_name,
        ROUND(AVG(energy_produced * 3600.0 / NULLIF(duration, 0)), 2) AS avg_ac_power_w,
        ROUND(AVG(dc_current), 4)   AS avg_dc_current_a,
        ROUND(AVG(dc_voltage), 2)   AS avg_dc_voltage_v,
        COUNT(*) AS reading_count
      FROM telemetry
      WHERE site_id = '${escapeSql(siteId)}' ${dateF}
        AND duration > 0 AND energy_produced > 0 AND dc_current > 0.1
      GROUP BY serial_number, sku_name
      HAVING COUNT(*) >= 5
    ),
    med AS (
      SELECT
        MEDIAN(avg_ac_power_w)    AS med_power,
        MEDIAN(avg_dc_current_a)  AS med_current,
        MEDIAN(avg_dc_voltage_v)  AS med_voltage
      FROM inv
    )
    SELECT
      i.serial_number, i.sku_name,
      i.avg_ac_power_w, i.avg_dc_current_a, i.avg_dc_voltage_v,
      ROUND(m.med_power, 2)   AS site_med_power_w,
      ROUND(m.med_current, 4) AS site_med_current_a,
      ROUND(m.med_voltage, 2) AS site_med_voltage_v,
      CASE WHEN m.med_power   > 0 THEN ROUND(ABS(i.avg_ac_power_w   - m.med_power)   / m.med_power   * 100, 1) ELSE NULL END AS power_dev_pct,
      CASE WHEN m.med_current > 0 THEN ROUND(ABS(i.avg_dc_current_a - m.med_current) / m.med_current * 100, 1) ELSE NULL END AS current_dev_pct,
      CASE WHEN m.med_voltage > 0 THEN ROUND(ABS(i.avg_dc_voltage_v - m.med_voltage) / m.med_voltage * 100, 1) ELSE NULL END AS voltage_dev_pct
    FROM inv i CROSS JOIN med m
    ORDER BY COALESCE(power_dev_pct, 0) DESC
    LIMIT 30
  `.trim()

  try {
    const rows = await query<Record<string, unknown>>(sql)
    if (rows.length < 2) return { has_mismatch: false, flagged_count: 0 }

    const DEV_THRESHOLD = 20  // % deviation from site median
    const flagged = rows.filter(
      (r) => safe(r.power_dev_pct) > DEV_THRESHOLD ||
              safe(r.current_dev_pct) > DEV_THRESHOLD ||
              safe(r.voltage_dev_pct) > DEV_THRESHOLD,
    )

    if (flagged.length === 0) return { has_mismatch: false, flagged_count: 0, total_analyzed: rows.length }

    const first = rows[0]
    return {
      has_mismatch: true,
      flagged_count: flagged.length,
      total_analyzed: rows.length,
      site_median_power_w: first.site_med_power_w,
      site_median_current_a: first.site_med_current_a,
      site_median_voltage_v: first.site_med_voltage_v,
      flagged_inverters: flagged.slice(0, 10).map((r) => ({
        serial_number: r.serial_number,
        sku_name: r.sku_name,
        avg_ac_power_w: r.avg_ac_power_w,
        avg_dc_current_a: r.avg_dc_current_a,
        avg_dc_voltage_v: r.avg_dc_voltage_v,
        power_dev_pct: r.power_dev_pct,
        current_dev_pct: r.current_dev_pct,
        voltage_dev_pct: r.voltage_dev_pct,
        flags: ([
          safe(r.power_dev_pct) > DEV_THRESHOLD   ? `AC power ${r.power_dev_pct}% off median` : null,
          safe(r.current_dev_pct) > DEV_THRESHOLD ? `DC current ${r.current_dev_pct}% off median` : null,
          safe(r.voltage_dev_pct) > DEV_THRESHOLD ? `DC voltage ${r.voltage_dev_pct}% off median` : null,
        ] as (string | null)[]).filter((x): x is string => x !== null),
      })),
    }
  } catch {
    return { has_mismatch: false, flagged_count: 0, error: 'Mismatch analysis unavailable' }
  }
}

/** Step 6: Proper clipping detection using detectClippingEvents algorithm */
async function detectClipping(siteId: string, dateRange?: { from?: string; to?: string }) {
  try {
    const dr =
      dateRange?.from && dateRange?.to
        ? { from: new Date(dateRange.from), to: new Date(dateRange.to) }
        : null
    const hourlyRows = await query<HourlyPoint>(buildClippingHourlyQuery([siteId], dr))
    if (!hourlyRows || hourlyRows.length === 0) return { events: [], power: false, current: false, classification: 'none', affected_days: 0, clipping_dates: [] }
    const events = detectClippingEvents(hourlyRows, DEFAULT_CLIPPING_OPTIONS)
    const powerEvents = events.filter((e) => e.type === 'power')
    const currentEvents = events.filter((e) => e.type === 'current')
    const affectedDates = [...new Set(events.map((e) => e.date))].sort()

    // Group clipping events by microinverter serial for the "See Microinverter's detail" toggle
    const bySerial: Record<string, { serial: string; sku: string | null; power_events: ClippingEvent[]; current_events: ClippingEvent[] }> = {}
    for (const e of events) {
      if (!bySerial[e.serial_number]) {
        bySerial[e.serial_number] = { serial: e.serial_number, sku: e.sku_name, power_events: [], current_events: [] }
      }
      if (e.type === 'power') bySerial[e.serial_number].power_events.push(e)
      else bySerial[e.serial_number].current_events.push(e)
    }

    return {
      events: events.slice(0, 20),
      events_by_serial: Object.values(bySerial).slice(0, 20),
      power: powerEvents.length > 0,
      current: currentEvents.length > 0,
      power_event_count: powerEvents.length,
      current_event_count: currentEvents.length,
      total_event_count: events.length,
      classification: classifyClipping(events.length),
      affected_days: affectedDates.length,
      clipping_dates: affectedDates.slice(0, 10),
    }
  } catch {
    return { events: [], events_by_serial: [], power: false, current: false, classification: 'none', affected_days: 0, clipping_dates: [] }
  }
}

// ─── Haversine distance (km) between two lat/lon points in degrees ───────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Return total RMA requests raised for the analyzed site itself. */
async function getSiteRmaCount(siteId: string): Promise<Record<string, unknown>> {
  try {
    await ensureRmaDataLoaded()
    const rows = await query<{ rma_count: number }>(`
      SELECT COUNT(*) AS rma_count
      FROM rma
      WHERE site_id = '${escapeSql(siteId)}'
    `)
    const count = rows[0]?.rma_count ?? 0
    return {
      site_id: siteId,
      rma_count: count,
      rma_available: true,
    }
  } catch {
    return {
      site_id: siteId,
      rma_count: 0,
      rma_available: false,
      note: 'RMA dataset is not loaded for this site.',
    }
  }
}

/** Search 10km radius around target site and summarize RMA / fleet density */
async function getNearbyRmaSummary(siteId: string, targetLat: number | null, targetLon: number | null): Promise<Record<string, unknown>> {
  if (targetLat == null || targetLon == null || Number.isNaN(targetLat) || Number.isNaN(targetLon)) {
    return { note: 'Coordinates unavailable — cannot search 10 km radius.' }
  }

  try {
    const roster = await getFleetRoster(siteId)
    const nearby = roster
      .filter((r) => r.latitude != null && r.longitude != null)
      .map((r) => ({ ...r, distance_km: haversineKm(targetLat, targetLon, Number(r.latitude), Number(r.longitude)) }))
      .filter((r) => r.distance_km <= 10)
      .sort((a, b) => a.distance_km - b.distance_km)

    const result: Record<string, unknown> = {
      radius_km: 10,
      nearby_site_count: nearby.length,
      nearby_sites: nearby.slice(0, 10).map((r) => ({
        site_id: r.site_id,
        distance_km: Math.round(r.distance_km * 10) / 10,
        location: [r.city, r.state, r.country].filter(Boolean).join(', '),
      })),
    }

    // RMA data is not part of the standard telemetry/fleet schema; attempt a lookup
    try {
      const rmaRows = await query<{ site_id: string; rma_count: number }>(`
        SELECT site_id, COUNT(*) AS rma_count
        FROM rma
        WHERE site_id IN (${nearby.length > 0 ? nearby.map((r) => `'${escapeSql(r.site_id)}'`).join(', ') : `'__none__'`})
        GROUP BY site_id
      `)
      const totalRma = rmaRows.reduce((s, r) => s + safe(r.rma_count), 0)
      result.rma_available = true
      result.rma_total_nearby = totalRma
      result.rma_per_site = rmaRows
    } catch {
      result.rma_available = false
      result.rma_note = 'No RMA dataset is currently loaded. This section shows nearby site density only.'
      result.rma_total_nearby = 0
    }

    return result
  } catch {
    return { note: 'Nearby site search unavailable.' }
  }
}

/** Step 8: Peer telemetry availability check */
async function checkPeerTelemetry(peerIds: string[]): Promise<Record<string, boolean>> {
  if (peerIds.length === 0) return {}
  const inList = peerIds.map((id) => `'${escapeSql(id)}'`).join(', ')
  const sql = `
    SELECT site_id, COUNT(*) AS readings
    FROM telemetry
    WHERE site_id IN (${inList})
    GROUP BY site_id
  `.trim()
  try {
    const rows = await query<{ site_id: string; readings: number }>(sql)
    const result: Record<string, boolean> = {}
    for (const id of peerIds) result[id] = false
    for (const row of rows) { if (safe(row.readings) > 0) result[row.site_id] = true }
    return result
  } catch {
    const result: Record<string, boolean> = {}
    for (const id of peerIds) result[id] = false
    return result
  }
}

/** Step 9: Peer daily production analysis (for common overlapping period) */
async function getPeerDailyProduction(
  peerIds: string[],
  targetFrom: string | undefined,
  targetTo: string | undefined,
): Promise<Record<string, { avg_daily_kwh: number; median_daily_kwh: number; valid_days: number }>> {
  if (peerIds.length === 0) return {}
  const inList = peerIds.map((id) => `'${escapeSql(id)}'`).join(', ')
  const dateF = [
    targetFrom ? `AND timestamp >= CAST('${escapeSql(targetFrom)}' AS TIMESTAMP)` : '',
    targetTo   ? `AND timestamp <= CAST('${escapeSql(targetTo)}' AS TIMESTAMP)` : '',
  ].join(' ')

  const sql = `
    SELECT
      site_id,
      CAST(timestamp AS DATE) AS date,
      SUM(energy_produced) / 1000.0 AS daily_kwh
    FROM telemetry
    WHERE site_id IN (${inList}) ${dateF}
      AND energy_produced > 0
    GROUP BY site_id, date
    ORDER BY site_id, date
  `.trim()

  try {
    const rows = await query<{ site_id: string; date: string; daily_kwh: number }>(sql)
    const byPeer: Record<string, number[]> = {}
    for (const id of peerIds) byPeer[id] = []
    for (const row of rows) {
      byPeer[row.site_id]?.push(safe(row.daily_kwh))
    }
    const result: Record<string, { avg_daily_kwh: number; median_daily_kwh: number; valid_days: number }> = {}
    for (const [id, vals] of Object.entries(byPeer)) {
      if (vals.length === 0) continue
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length
      const sorted = [...vals].sort((a, b) => a - b)
      const n = sorted.length
      const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
      result[id] = {
        avg_daily_kwh: Math.round(avg * 100) / 100,
        median_daily_kwh: Math.round(median * 100) / 100,
        valid_days: n,
      }
    }
    return result
  } catch {
    return {}
  }
}

// ─── Main execution ──────────────────────────────────────────────────────────

async function executeAnalyzeSite(params: AnalyzeSiteParams): Promise<ToolResult> {
  const started = Date.now()
  const { siteId, from, to } = params

  // Step 1: Fleet info for target site
  const fleetRows = await getFleetInfo(siteId)

  // Step 2: Telemetry availability check
  let telemetryInfo: Record<string, unknown>[] = []
  try {
    telemetryInfo = await checkTelemetry(siteId)
  } catch { /* telemetry table may not exist */ }

  const hasTelemetry = telemetryInfo.length > 0 && safe(telemetryInfo[0]?.reading_count) > 0

  const result: Record<string, unknown> = {
    site_id: siteId,
    _analysis_type: 'comprehensive_site_analysis',
  }

  // ── Fleet profile ──────────────────────────────────────────────────────────
  let targetFleetRow: FleetRow | null = null
  if (fleetRows.length > 0) {
    const f = fleetRows[0]
    targetFleetRow = f as unknown as FleetRow
    const gridProfile = inferGridProfile(
      String(f.country ?? ''),
      String(f.state ?? ''),
      f.circuit_phase as string | null,
      f.production_eim_config as string | null,
    )
    result.fleet_summary = {
      country: f.country,
      region: f.tss_region,
      tss_country: f.tss_country,
      city: f.city,
      state: f.state,
      latitude: f.latitude,
      longitude: f.longitude,
      product_type: f.product_type,
      device_type: f.device_type_name,
      model_name: f.model_name,
      pv_module_make: f.pv_module_make,
      pv_module_model: f.pv_module_model,
      module_wafer: f.module_wafer,
      stc_rating_w: f.stc_rating2,
      stc_mwdc: f.stc_mwdc,
      mwac: f.mwac,
      dc_ac_ratio: f.dc_ac_ratio,
      unit_count: f.unit_count,
      voc: f.voc,
      isc: f.isc,
      irradiance_kwh_m2_month: f.irr_ann_kwh_m2_month,
      quarter_first_interval: f.quarter_first_interval,
      grid_profile: gridProfile,
      circuit_phase: f.circuit_phase,
      production_eim_config: f.production_eim_config,
      consumption_eim_config: f.consumption_eim_config,
    }
    if (fleetRows.length > 1) {
      result.fleet_all_rows = fleetRows.map((r) => ({
        product_type: r.product_type,
        model_name: r.model_name,
        pv_module_make: r.pv_module_make,
        pv_module_model: r.pv_module_model,
        unit_count: r.unit_count,
        stc_rating_w: r.stc_rating2,
      }))
    }
  } else {
    result.fleet_summary = null
    result.fleet_note = `Site ${siteId} was not found in Fleet data.`
  }

  // ── Peer site discovery (Fleet only — never Telemetry) ────────────────────
  if (targetFleetRow) {
    try {
      const roster = await getFleetRoster(siteId)
      const requireModuleInfo = params.requireModuleInfo !== false  // default true
      const peers = findSimilarSites(targetFleetRow, roster, { ...DEFAULT_SIMILARITY_CONFIG, requireModuleInfo })
      result.comparable_sites = peers
      result.comparable_sites_found = peers.length

      if (peers.length > 0) {
        // Step 8: Peer telemetry availability
        const peerIds = peers.map((p) => p.site_id)
        const peerTelemetry = await checkPeerTelemetry(peerIds)
        const peersWithTelemetry = peerIds.filter((id) => peerTelemetry[id])
        result.comparable_sites = peers.map((p) => ({ ...p, telemetry_available: peerTelemetry[p.site_id] ?? false }))
        result.peers_with_telemetry = peersWithTelemetry.length
        result.peers_without_telemetry = peerIds.length - peersWithTelemetry.length
      }

      // RMA count for the analyzed site itself (also ensures RMA data is loaded)
      result.site_rma = await getSiteRmaCount(siteId)

      // RMA / nearby 10km fleet density summary
      result.rma_summary = await getNearbyRmaSummary(
        siteId,
        targetFleetRow.latitude != null ? Number(targetFleetRow.latitude) : null,
        targetFleetRow.longitude != null ? Number(targetFleetRow.longitude) : null,
      )
    } catch {
      result.comparable_sites = []
      result.comparable_sites_note = 'Peer discovery unavailable.'
    }
  }

  // ── Telemetry analysis ────────────────────────────────────────────────────
  result.telemetry_available = hasTelemetry

  if (hasTelemetry) {
    const t = telemetryInfo[0]
    const firstReading = String(t.first_reading ?? '')
    const lastReading = String(t.last_reading ?? '')
    result.telemetry_overview = {
      microinverter_count: safe(t.micro_count),
      total_readings: safe(t.reading_count),
      sku_count: safe(t.sku_count),
      first_reading: firstReading,
      last_reading: lastReading,
      days_of_data: safe(t.day_count),
    }

    // Step 3: Site energy + daily production + trend
    const { aggregate: siteEnergyRows, daily } = await getSiteEnergy(siteId, from, to)
    if (siteEnergyRows.length > 0) {
      result.site_energy = siteEnergyRows[0]
    }
    const trendData = computeTrend(daily)
    result.production = {
      ...trendData,
      period_from: from ?? firstReading,
      period_to: to ?? lastReading,
    }

    // Step 4: Per-inverter energy + detailed AC power + environment
    const perInverter = await getPerInverterEnergy(siteId, from, to)
    if (perInverter.length > 0) {
      result.microinverter_count = perInverter.length
      result.top_performers = perInverter.slice(0, 5)
      result.bottom_performers = perInverter.slice(-Math.min(5, perInverter.length)).reverse()
    }
    const acPowerStats = await getPerInverterAcPowerStats(siteId, from, to)
    if (acPowerStats.length > 0) result.microinverter_ac_power = acPowerStats
    const envStats = await getPerInverterEnvironment(siteId, from, to)
    if (envStats.length > 0) result.microinverter_environment = envStats

    // Step 5: Anomaly detection
    const anomalies = await detectAnomalies(siteId, from, to)
    const alerts = anomalies.filter((r) => r.status === 'alert')
    const warnings = anomalies.filter((r) => r.status === 'warning')
    result.anomaly_summary = {
      total_inverters_analyzed: anomalies.length,
      alerts: alerts.length,
      warnings: warnings.length,
      normal: anomalies.length - alerts.length - warnings.length,
    }
    if (alerts.length > 0) result.anomaly_alerts = alerts.slice(0, 10)
    if (warnings.length > 0) result.anomaly_warnings = warnings.slice(0, 10)

    // Step 6: Proper clipping analysis + reason breakdown
    const clipping = await detectClipping(siteId, { from, to })
    result.clipping = clipping
    if (Array.isArray(clipping.events) && clipping.events.length > 0) {
      result.clipping_reasons = analyzeClippingReasons(clipping.events as ClippingEvent[])
    }

    // Step 7: Per-inverter mismatch detection
    result.inverter_mismatch = await detectInverterMismatch(siteId, from, to)

    // Step 9: Peer benchmarking (only for peers with telemetry, using target period)
    const peersArray = (result.comparable_sites ?? []) as Array<{ site_id: string; telemetry_available: boolean }>
    const peersWithTel = peersArray.filter((p) => p.telemetry_available).map((p) => p.site_id)
    if (peersWithTel.length > 0) {
      const peerProduction = await getPeerDailyProduction(peersWithTel, from ?? firstReading, to ?? lastReading)
      const peerAvgs = Object.values(peerProduction).map((p) => p.avg_daily_kwh).filter((v) => v > 0)
      if (peerAvgs.length > 0 && trendData.avg_daily_kwh > 0) {
        const peerMean = peerAvgs.reduce((a, b) => a + b, 0) / peerAvgs.length
        const sortedAvgs = [...peerAvgs].sort((a, b) => a - b)
        const n = sortedAvgs.length
        const peerMedian = n % 2 === 0 ? (sortedAvgs[n / 2 - 1] + sortedAvgs[n / 2]) / 2 : sortedAvgs[Math.floor(n / 2)]
        const deviationPct = peerMedian > 0 ? ((trendData.avg_daily_kwh - peerMedian) / peerMedian) * 100 : null

        result.peer_benchmarking = {
          comparison_period: `${from ?? firstReading} to ${to ?? lastReading}`,
          target_avg_daily_kwh: trendData.avg_daily_kwh,
          peer_avg_daily_kwh: Math.round(peerMean * 100) / 100,
          peer_median_daily_kwh: Math.round(peerMedian * 100) / 100,
          deviation_pct: deviationPct !== null ? Math.round(deviationPct * 10) / 10 : null,
          peers_analyzed: peerAvgs.length,
          low_confidence: peerAvgs.length < 2,
          per_peer: Object.fromEntries(
            Object.entries(peerProduction).map(([id, p]) => [id, p])
          ),
        }
      }
    }
  } else {
    result.telemetry_note = `Site ${siteId} exists in Fleet, but telemetry is not available. Performance and clipping analysis cannot be completed.`
  }

  const sections: string[] = ['fleet', 'peers']
  if (hasTelemetry) sections.push('telemetry', 'energy', 'trends', 'anomaly', 'clipping', 'peer_benchmarking')

  return {
    rows: [result],
    metadata: {
      tool: 'analyze_site',
      params: params as unknown as Record<string, unknown>,
      sql: `-- Multi-step site analysis: ${sections.join(' + ')}`,
      executionMs: Date.now() - started,
      rowCount: 1,
      warning: !hasTelemetry
        ? `Telemetry not available for site ${siteId}. Fleet metadata and peer discovery only.`
        : undefined,
    },
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const analyzeSiteTool: AnalyticsTool<AnalyzeSiteParams> = {
  name: 'analyze_site',
  description: 'Comprehensive site analysis: Fleet profile (module, inverter, location, irradiance), peer site discovery (up to 5 nearby comparable sites via Haversine + similarity scoring), telemetry check, daily energy + trend, proper power/current clipping detection, anomaly detection, peer telemetry comparison, and peer benchmarking. Use for "analyze site X", "deep dive site X", "investigate site X", "why is X underperforming", "tell me everything about site X" questions.',
  parametersSchema: AnalyzeSiteParams,
  execute: executeAnalyzeSite,
}
