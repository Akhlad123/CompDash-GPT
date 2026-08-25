// Fleet roster search — finds sites matching user-specified criteria.
// Handles: microinverter model, module power range, country, state,
// irradiance level, module wafer type, and module manufacturer.
// Query: "Give me 10 sites with IQ8HC and 420W modules in France with high irradiance"

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import type { AnalyticsTool, ToolResult } from './types'

function escapeSql(s: string): string { return s.replace(/'/g, "''") }

// ─── Irradiance level thresholds (kWh/m²/day) ───────────────────────────────
// NOTE: despite the column name containing "month", the stored values are
// annual-average daily irradiance in kWh/m²/day (confirmed by SiteContextPanel).

const IRRADIANCE_THRESHOLDS = {
  very_high: { min: 5.5, max: null,  label: '> 5.5 kWh/m²/day' },
  high:      { min: 4.5, max: null,  label: '> 4.5 kWh/m²/day' },
  medium:    { min: 3.5, max: 4.5,   label: '3.5 – 4.5 kWh/m²/day' },
  low:       { min: null, max: 3.5,  label: '< 3.5 kWh/m²/day' },
} as const

// ─── Parameters ───────────────────────────────────────────────────────────────

const FleetSearchParams = z.object({
  microinverter: z.string().optional(),                        // e.g., "IQ8HC", "IQ7+", "IQ9N"
  minPowerW:     z.number().min(0).max(10000).optional(),      // module STC power min (W)
  maxPowerW:     z.number().min(0).max(10000).optional(),      // module STC power max (W)
  country:       z.string().optional(),                        // e.g., "France", "Germany"
  state:         z.string().optional(),                        // e.g., "California"
  irradiance:    z.enum(['very_high', 'high', 'medium', 'low']).optional(),
  moduleWafer:   z.string().optional(),                        // e.g., "monocrystalline"
  moduleMake:    z.string().optional(),                        // e.g., "LG", "SunPower"
  topN:          z.number().int().min(1).max(500).default(10),
})
type FleetSearchParams = z.infer<typeof FleetSearchParams>

// ─── Execution ────────────────────────────────────────────────────────────────

async function executeFleetSearch(params: FleetSearchParams): Promise<ToolResult> {
  const started = Date.now()
  const { microinverter, minPowerW, maxPowerW, country, state,
          irradiance, moduleWafer, moduleMake, topN } = params

  const conditions: string[] = ['site_id IS NOT NULL']

  // Microinverter — prefix match on model_name, fallback to product_type
  if (microinverter) {
    const m = escapeSql(microinverter.trim().toUpperCase())
    conditions.push(
      `(UPPER(COALESCE(model_name, '')) LIKE '${m}%' OR UPPER(COALESCE(product_type, '')) LIKE '${m}%')`
    )
  }

  // Module STC power range
  if (minPowerW != null) conditions.push(`stc_rating2 >= ${minPowerW}`)
  if (maxPowerW != null) conditions.push(`stc_rating2 <= ${maxPowerW}`)

  // Country — case-insensitive exact match
  if (country) {
    const c = escapeSql(country.trim())
    conditions.push(`LOWER(COALESCE(country, '')) = LOWER('${c}')`)
  }

  // State / province
  if (state) {
    const st = escapeSql(state.trim())
    conditions.push(`LOWER(COALESCE(state, '')) = LOWER('${st}')`)
  }

  // Irradiance level
  if (irradiance) {
    const thr = IRRADIANCE_THRESHOLDS[irradiance]
    if (thr.min != null) conditions.push(`irr_ann_kwh_m2_month >= ${thr.min}`)
    if (thr.max != null) conditions.push(`irr_ann_kwh_m2_month <  ${thr.max}`)
  }

  // Module wafer type
  if (moduleWafer) {
    const w = escapeSql(moduleWafer.trim().toLowerCase())
    conditions.push(`LOWER(COALESCE(module_wafer, '')) LIKE '%${w}%'`)
  }

  // Module manufacturer
  if (moduleMake) {
    const mk = escapeSql(moduleMake.trim().toLowerCase())
    conditions.push(`LOWER(COALESCE(pv_module_make, '')) LIKE '%${mk}%'`)
  }

  // Sort: irradiance DESC if irradiance filter applied (show sunniest first),
  // otherwise sort by country+city for geographic grouping
  const orderBy = irradiance
    ? 'irr_ann_kwh_m2_month DESC, site_id'
    : 'country, state, city, site_id'

  const where = conditions.join('\n      AND ')

  const sql = `
    SELECT
      site_id,
      COALESCE(country, '') AS country,
      COALESCE(state, '')   AS state,
      COALESCE(city, '')    AS city,
      tss_region,
      product_type,
      model_name,
      pv_module_make,
      pv_module_model,
      module_wafer,
      ROUND(CAST(stc_rating2 AS DOUBLE), 1)           AS stc_rating_w,
      ROUND(CAST(dc_ac_ratio AS DOUBLE), 3)            AS dc_ac_ratio,
      ROUND(CAST(irr_ann_kwh_m2_month AS DOUBLE), 1)  AS irr_ann_kwh_m2_month,
      CAST(unit_count AS INTEGER)                      AS unit_count,
      quarter_first_interval,
      ROUND(CAST(mwac AS DOUBLE), 4)                   AS mwac,
      ROUND(CAST(latitude AS DOUBLE), 4)               AS latitude,
      ROUND(CAST(longitude AS DOUBLE), 4)              AS longitude
    FROM fleet
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${topN}
  `.trim()

  try {
    const rows = await query<Record<string, unknown>>(sql)

    // Build applied-filters summary for UI / explainer
    const appliedFilters: Record<string, string> = {}
    if (microinverter)                 appliedFilters.microinverter = microinverter
    if (minPowerW != null || maxPowerW != null) {
      appliedFilters.power_range_w = `${minPowerW ?? 0} – ${maxPowerW ?? '∞'} W`
    }
    if (country)   appliedFilters.country   = country
    if (state)     appliedFilters.state     = state
    if (irradiance) appliedFilters.irradiance =
      `${irradiance} (${IRRADIANCE_THRESHOLDS[irradiance].label})`
    if (moduleWafer) appliedFilters.module_wafer = moduleWafer
    if (moduleMake)  appliedFilters.module_make  = moduleMake

    return {
      rows,
      metadata: {
        tool: 'fleet_search',
        params: params as unknown as Record<string, unknown>,
        sql,
        executionMs: Date.now() - started,
        rowCount: rows.length,
        warning: rows.length === 0
          ? `No sites matched: ${JSON.stringify(appliedFilters)}`
          : undefined,
      },
    }
  } catch (err) {
    return {
      rows: [],
      metadata: {
        tool: 'fleet_search',
        params: params as unknown as Record<string, unknown>,
        sql,
        executionMs: Date.now() - started,
        rowCount: 0,
        warning: `Fleet search error: ${String(err)}`,
      },
    }
  }
}

// ─── Export ────────────────────────────────────────────────────────────────────

export const fleetSearchTool: AnalyticsTool<FleetSearchParams> = {
  name: 'fleet_search',
  description:
    'Search the fleet roster for sites matching specific criteria. Supported filters: ' +
    'microinverter model (IQ8HC, IQ9N, IQ7+, IQ8P, etc.), ' +
    'module STC power range (e.g., 420 W or 450–500 W range), ' +
    'country (France, Germany, United States, Australia, Brazil, India, etc.), ' +
    'state/province (California, Texas, etc.), ' +
    'irradiance level (very_high >5.5, high >4.5, medium 3.5–4.5, low <3.5 kWh/m²/day), ' +
    'module_wafer (monocrystalline, polycrystalline), ' +
    'module_make (manufacturer name). ' +
    'topN controls how many results to return (default 10, up to 500). ' +
    'Use for questions like: "Give me 10 sites with IQ8HC and 420W modules in France with high irradiance", ' +
    '"Find 20 sites with IQ8P and 450-500W in Germany", ' +
    '"Show sites in California with monocrystalline 400W+ modules".',
  parametersSchema: FleetSearchParams,
  execute: executeFleetSearch,
}
