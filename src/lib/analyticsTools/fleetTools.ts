// Fleet analytics tools. All queries target the `fleet` DuckDB table.
// No user-supplied strings ever reach SQL directly — all dimension/metric
// names are validated against explicit allowlists before query construction.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import { buildFleetFilter, HAS_MODULE_DATA_SQL } from '@/lib/fleetQueries'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'

// ─── Allowlists (security boundary) ──────────────────────────────────────────

const FLEET_DIMENSION_COLS = [
  'country', 'tss_region', 'tss_country', 'region_bundle',
  'product_type', 'module_wafer', 'power_bucket', 'power_block',
  'quarter_first_interval', 'quarter_device_created', 'city', 'state',
  'pv_module_make', 'pv_module_model', 'device_type_name',
] as const
type FleetDimension = typeof FLEET_DIMENSION_COLS[number]

const FLEET_NUMERIC_COLS = [
  'unit_count', 'stc_mwdc', 'mwac', 'dc_ac_ratio',
  'stc_rating2', 'irr_ann_kwh_m2_month', 'voc', 'isc',
] as const

const AGGREGATION_SQL: Record<string, (col: string) => string> = {
  sum:   (c) => `SUM(${c})`,
  avg:   (c) => `AVG(${c})`,
  min:   (c) => `MIN(${c})`,
  max:   (c) => `MAX(${c})`,
  count: (_c) => `COUNT(DISTINCT site_id)`,
  p50:   (c) => `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${c})`,
  p90:   (c) => `PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${c})`,
  p95:   (c) => `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${c})`,
}

// ─── Zod dimension / filter schemas ──────────────────────────────────────────

const FleetDimensionSchema = z.enum(FLEET_DIMENSION_COLS)
const FleetNumericSchema = z.enum(FLEET_NUMERIC_COLS)
const AggregationSchema = z.enum(['sum', 'avg', 'min', 'max', 'count', 'p50', 'p90', 'p95'])

const FleetFiltersSchema = z.object({
  quarters:     z.array(z.string()).optional(),
  regions:      z.array(z.string()).optional(),
  tssRegions:   z.array(z.string()).optional(),
  tssCountries: z.array(z.string()).optional(),
  countries:    z.array(z.string()).optional(),
}).optional()

// ─── Shared SQL helper ────────────────────────────────────────────────────────

function safeGroupBy(dims: FleetDimension[]): string {
  return dims.join(', ')
}

function safeWhere(filters?: z.infer<typeof FleetFiltersSchema>): string {
  return buildFleetFilter({
    quarters:     filters?.quarters,
    regions:      filters?.regions,
    tssRegions:   filters?.tssRegions,
    tssCountries: filters?.tssCountries,
    countries:    filters?.countries,
  })
}

// ─── Tool 1: get_fleet_summary ────────────────────────────────────────────────

const FleetSummaryParams = z.object({
  metric:      FleetNumericSchema.default('unit_count'),
  aggregation: AggregationSchema.default('sum'),
  groupBy:     z.array(FleetDimensionSchema).min(1).max(3),
  filters:     FleetFiltersSchema,
  limit:       z.number().int().min(1).max(MAX_RESULT_ROWS).default(50),
  orderDesc:   z.boolean().default(true),
})
type FleetSummaryParams = z.infer<typeof FleetSummaryParams>

async function executeFleetSummary(params: FleetSummaryParams): Promise<ToolResult> {
  const started = Date.now()
  const aggExprStr = AGGREGATION_SQL[params.aggregation](params.metric)
  const groupCols = safeGroupBy(params.groupBy)
  const where = safeWhere(params.filters)
  const order = params.orderDesc ? 'DESC' : 'ASC'

  const sql = `
    SELECT ${groupCols}, ${aggExprStr} AS result
    FROM fleet
    WHERE ${where}
    GROUP BY ${groupCols}
    ORDER BY result ${order} NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_fleet_summary',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getFleetSummaryTool: AnalyticsTool<FleetSummaryParams> = {
  name: 'get_fleet_summary',
  description: 'Aggregate any fleet numeric metric (units, MWdc, DC/AC ratio, STC rating, irradiance) grouped by one or more dimensions (region, country, product, wafer, quarter). Use for "how many", "which region", "by country" questions.',
  parametersSchema: FleetSummaryParams,
  execute: executeFleetSummary,
}

// ─── Tool 2: get_site_summary ─────────────────────────────────────────────────

const SiteSummaryParams = z.object({
  siteId: z.string().min(1),
})
type SiteSummaryParams = z.infer<typeof SiteSummaryParams>

async function executeSiteSummary(params: SiteSummaryParams): Promise<ToolResult> {
  const started = Date.now()
  const escaped = params.siteId.replace(/'/g, "''")
  const sql = `
    SELECT
      site_id, country, tss_region, tss_country, region_bundle,
      product_type, device_type_name, pv_module_make, pv_module_model,
      module_wafer, stc_rating2, stc_mwdc, mwac, dc_ac_ratio,
      unit_count, power_bucket, quarter_first_interval,
      city, state, zip_code, latitude, longitude,
      irr_ann_kwh_m2_month, voc, isc
    FROM fleet
    WHERE site_id = '${escaped}'
    LIMIT 10
  `.trim()
  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_site_summary',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getSiteSummaryTool: AnalyticsTool<SiteSummaryParams> = {
  name: 'get_site_summary',
  description: 'Retrieve full fleet metadata for a specific site_id: country, region, product type, module specs, DC/AC ratio, unit count, irradiance, location.',
  parametersSchema: SiteSummaryParams,
  execute: executeSiteSummary,
}

// ─── Tool 3: get_product_summary ──────────────────────────────────────────────

const ProductSummaryParams = z.object({
  groupBy:     z.array(FleetDimensionSchema).min(1).max(2).default(['product_type']),
  filters:     FleetFiltersSchema,
  includeWafer: z.boolean().default(true),
  limit:       z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
})
type ProductSummaryParams = z.infer<typeof ProductSummaryParams>

async function executeProductSummary(params: ProductSummaryParams): Promise<ToolResult> {
  const started = Date.now()
  const where = safeWhere(params.filters)
  const groupCols = safeGroupBy(params.groupBy)
  const waferCol = params.includeWafer && !params.groupBy.includes('module_wafer')
    ? ', module_wafer'
    : ''
  const fullGroupBy = waferCol
    ? `${groupCols}, module_wafer`
    : groupCols

  const sql = `
    SELECT
      ${groupCols}${waferCol},
      COUNT(DISTINCT site_id)     AS site_count,
      SUM(unit_count)             AS total_units,
      SUM(stc_mwdc)               AS total_mwdc,
      AVG(CASE WHEN ${HAS_MODULE_DATA_SQL} THEN stc_rating2 END) AS avg_stc_rating_w,
      AVG(CASE WHEN ${HAS_MODULE_DATA_SQL} THEN dc_ac_ratio END) AS avg_dc_ac_ratio
    FROM fleet
    WHERE ${where}
    GROUP BY ${fullGroupBy}
    ORDER BY total_units DESC NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_product_summary',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getProductSummaryTool: AnalyticsTool<ProductSummaryParams> = {
  name: 'get_product_summary',
  description: 'Fleet breakdown by product_type and/or module_wafer: unit counts, site counts, total MWdc, average STC rating, average DC/AC ratio. Use for "IQ9N vs IQ8HC", "by wafer technology", "product mix" questions.',
  parametersSchema: ProductSummaryParams,
  execute: executeProductSummary,
}

// ─── Tool 4: get_region_summary ───────────────────────────────────────────────

const RegionSummaryParams = z.object({
  filters: FleetFiltersSchema,
  mode:    z.enum(['units', 'sites']).default('units'),
})
type RegionSummaryParams = z.infer<typeof RegionSummaryParams>

async function executeRegionSummary(params: RegionSummaryParams): Promise<ToolResult> {
  const started = Date.now()
  const where = safeWhere(params.filters)
  const totalAgg = params.mode === 'sites' ? 'COUNT(DISTINCT site_id)' : 'SUM(unit_count)'

  const sql = `
    WITH base AS (
      SELECT *, ${HAS_MODULE_DATA_SQL} AS has_data
      FROM fleet
      WHERE tss_region IS NOT NULL AND ${where}
    )
    SELECT
      tss_region,
      COUNT(DISTINCT site_id)                          AS site_count,
      ${totalAgg}                                      AS total_units,
      SUM(CASE WHEN has_data THEN unit_count ELSE 0 END) AS units_with_module_data,
      SUM(stc_mwdc)                                    AS total_mwdc,
      SUM(mwac)                                        AS total_mwac,
      AVG(CASE WHEN has_data THEN stc_rating2 END)     AS avg_stc_rating_w,
      AVG(CASE WHEN has_data THEN dc_ac_ratio END)     AS avg_dc_ac_ratio,
      AVG(irr_ann_kwh_m2_month)                        AS avg_irradiance_kwh_m2_month
    FROM base
    GROUP BY tss_region
    ORDER BY total_units DESC NULLS LAST
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_region_summary',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getRegionSummaryTool: AnalyticsTool<RegionSummaryParams> = {
  name: 'get_region_summary',
  description: 'Fleet summary by TSS region: site count, units, MWdc, MWac, avg STC rating, avg DC/AC ratio, avg irradiance. Use for regional overview or "compare regions" questions.',
  parametersSchema: RegionSummaryParams,
  execute: executeRegionSummary,
}

// ─── Tool 5: get_dc_ac_ratio ──────────────────────────────────────────────────

const DcAcRatioParams = z.object({
  groupBy:     z.array(FleetDimensionSchema).min(1).max(3).default(['tss_region']),
  filters:     FleetFiltersSchema,
  aggregation: AggregationSchema.default('avg'),
  limit:       z.number().int().min(1).max(MAX_RESULT_ROWS).default(50),
})
type DcAcRatioParams = z.infer<typeof DcAcRatioParams>

async function executeDcAcRatio(params: DcAcRatioParams): Promise<ToolResult> {
  const started = Date.now()
  const where = safeWhere(params.filters)
  const groupCols = safeGroupBy(params.groupBy)
  const aggStr = AGGREGATION_SQL[params.aggregation]('dc_ac_ratio')

  const sql = `
    SELECT
      ${groupCols},
      ${aggStr}                                AS dc_ac_ratio,
      AVG(dc_ac_ratio)                          AS avg_dc_ac_ratio,
      MIN(dc_ac_ratio)                          AS min_dc_ac_ratio,
      MAX(dc_ac_ratio)                          AS max_dc_ac_ratio,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dc_ac_ratio) AS median_dc_ac_ratio,
      COUNT(DISTINCT site_id)                   AS site_count,
      SUM(unit_count)                           AS total_units
    FROM fleet
    WHERE ${HAS_MODULE_DATA_SQL} AND ${where}
    GROUP BY ${groupCols}
    ORDER BY avg_dc_ac_ratio DESC NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_dc_ac_ratio',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const getDcAcRatioTool: AnalyticsTool<DcAcRatioParams> = {
  name: 'get_dc_ac_ratio',
  description: 'Analyze DC/AC ratio (oversizing factor) across fleet dimensions. Returns avg, min, max, median by region/country/product/wafer/quarter. Use for "DC/AC ratio", "oversizing", "sizing ratio" questions.',
  parametersSchema: DcAcRatioParams,
  execute: executeDcAcRatio,
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const FLEET_TOOLS = [
  getFleetSummaryTool,
  getSiteSummaryTool,
  getProductSummaryTool,
  getRegionSummaryTool,
  getDcAcRatioTool,
] as const
