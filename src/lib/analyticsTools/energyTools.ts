// Energy analytics tools — target the `telemetry` DuckDB table.
// All group-by and filter columns are allowlisted; no user strings reach SQL directly.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'

function escapeSql(s: string): string {
  return s.replace(/'/g, "''")
}

function buildSiteFilter(siteIds?: string[]): string {
  if (!siteIds || siteIds.length === 0) return ''
  const list = siteIds.map((s) => `'${escapeSql(s)}'`).join(', ')
  return `AND site_id IN (${list})`
}

function buildSerialFilter(serials?: string[]): string {
  if (!serials || serials.length === 0) return ''
  const list = serials.map((s) => `'${escapeSql(s)}'`).join(', ')
  return `AND serial_number IN (${list})`
}

function buildSkuFilter(skus?: string[]): string {
  if (!skus || skus.length === 0) return ''
  const list = skus.map((s) => `'${escapeSql(s)}'`).join(', ')
  return `AND sku_name IN (${list})`
}

function buildDateFilter(from?: string, to?: string): string {
  const parts: string[] = []
  if (from) parts.push(`AND timestamp >= CAST('${escapeSql(from)}' AS TIMESTAMP)`)
  if (to)   parts.push(`AND timestamp <= CAST('${escapeSql(to)}' AS TIMESTAMP)`)
  return parts.join(' ')
}

const EnergyFilterSchema = z.object({
  siteIds:   z.array(z.string()).optional(),
  serials:   z.array(z.string()).optional(),
  skuNames:  z.array(z.string()).optional(),
  from:      z.string().optional(),
  to:        z.string().optional(),
})

// ─── Tool 1: calculate_energy ─────────────────────────────────────────────────

const CalculateEnergyParams = z.object({
  groupBy:  z.enum(['site_id', 'serial_number', 'sku_name', 'date', 'site_and_date']).default('site_id'),
  filters:  EnergyFilterSchema.optional(),
  unit:     z.enum(['Wh', 'kWh', 'MWh']).default('kWh'),
  limit:    z.number().int().min(1).max(MAX_RESULT_ROWS).default(100),
  orderDesc: z.boolean().default(true),
})
type CalculateEnergyParams = z.infer<typeof CalculateEnergyParams>

async function executeCalculateEnergy(params: CalculateEnergyParams): Promise<ToolResult> {
  const started = Date.now()
  const f = params.filters ?? {}
  const siteF   = buildSiteFilter(f.siteIds)
  const serialF = buildSerialFilter(f.serials)
  const skuF    = buildSkuFilter(f.skuNames)
  const dateF   = buildDateFilter(f.from, f.to)
  const order   = params.orderDesc ? 'DESC' : 'ASC'

  const divisor = params.unit === 'kWh' ? 1000.0 : params.unit === 'MWh' ? 1_000_000.0 : 1.0

  let selectCols: string
  let groupCols: string

  switch (params.groupBy) {
    case 'site_id':
      selectCols = 'site_id'
      groupCols  = 'site_id'
      break
    case 'serial_number':
      selectCols = 'serial_number, site_id, sku_name'
      groupCols  = 'serial_number, site_id, sku_name'
      break
    case 'sku_name':
      selectCols = 'sku_name'
      groupCols  = 'sku_name'
      break
    case 'date':
      selectCols = `CAST(COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE)) AS VARCHAR) AS date`
      groupCols  = `COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE))`
      break
    case 'site_and_date':
      selectCols = `site_id, CAST(COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE)) AS VARCHAR) AS date`
      groupCols  = `site_id, COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE))`
      break
  }

  const sql = `
    SELECT
      ${selectCols},
      SUM(energy_produced) / ${divisor} AS energy_${params.unit.toLowerCase()},
      COUNT(DISTINCT serial_number)     AS inverter_count,
      COUNT(*)                          AS reading_count
    FROM telemetry
    WHERE 1=1 ${siteF} ${serialF} ${skuF} ${dateF}
    GROUP BY ${groupCols}
    ORDER BY energy_${params.unit.toLowerCase()} ${order} NULLS LAST
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'calculate_energy',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const calculateEnergyTool: AnalyticsTool<CalculateEnergyParams> = {
  name: 'calculate_energy',
  description: 'Total energy production grouped by site, inverter, SKU model, date, or site+date. Supports kWh/MWh/Wh output and date/site/serial filters. Use for "total energy", "how much energy", "daily production" questions.',
  parametersSchema: CalculateEnergyParams,
  execute: executeCalculateEnergy,
}

// ─── Tool 2: compare_energy ───────────────────────────────────────────────────

const CompareEnergyParams = z.object({
  groupA:    z.object({ label: z.string(), skuNames: z.array(z.string()).optional(), siteIds: z.array(z.string()).optional() }),
  groupB:    z.object({ label: z.string(), skuNames: z.array(z.string()).optional(), siteIds: z.array(z.string()).optional() }),
  groupBy:   z.enum(['site_id', 'sku_name', 'total']).default('total'),
  from:      z.string().optional(),
  to:        z.string().optional(),
  unit:      z.enum(['Wh', 'kWh', 'MWh']).default('kWh'),
})
type CompareEnergyParams = z.infer<typeof CompareEnergyParams>

async function executeCompareEnergy(params: CompareEnergyParams): Promise<ToolResult> {
  const started = Date.now()
  const divisor = params.unit === 'kWh' ? 1000.0 : params.unit === 'MWh' ? 1_000_000.0 : 1.0
  const dateF = buildDateFilter(params.from, params.to)

  function groupFilter(g: typeof params.groupA): string {
    const parts: string[] = []
    if (g.skuNames && g.skuNames.length > 0) parts.push(buildSkuFilter(g.skuNames).slice(4))
    if (g.siteIds  && g.siteIds.length  > 0) parts.push(buildSiteFilter(g.siteIds).slice(4))
    return parts.length > 0 ? `(${parts.join(' AND ')})` : '1=1'
  }

  const labelA = escapeSql(params.groupA.label)
  const labelB = escapeSql(params.groupB.label)

  let outerGroupBy = ''
  let innerSelect  = ''
  if (params.groupBy === 'site_id') {
    innerSelect  = 'site_id,'
    outerGroupBy = 'GROUP BY site_id'
  } else if (params.groupBy === 'sku_name') {
    innerSelect  = 'sku_name,'
    outerGroupBy = 'GROUP BY sku_name'
  }

  const sql = `
    WITH
      a AS (
        SELECT ${innerSelect} SUM(energy_produced) / ${divisor} AS energy
        FROM telemetry
        WHERE ${groupFilter(params.groupA)} ${dateF}
        ${outerGroupBy}
      ),
      b AS (
        SELECT ${innerSelect} SUM(energy_produced) / ${divisor} AS energy
        FROM telemetry
        WHERE ${groupFilter(params.groupB)} ${dateF}
        ${outerGroupBy}
      )
    SELECT
      ${params.groupBy !== 'total' ? `COALESCE(a.${params.groupBy}, b.${params.groupBy}) AS ${params.groupBy},` : ''}
      COALESCE(a.energy, 0)    AS energy_${labelA}_${params.unit.toLowerCase()},
      COALESCE(b.energy, 0)    AS energy_${labelB}_${params.unit.toLowerCase()},
      COALESCE(a.energy, 0) - COALESCE(b.energy, 0) AS diff_${params.unit.toLowerCase()},
      CASE
        WHEN COALESCE(b.energy, 0) > 0
        THEN ROUND(((COALESCE(a.energy, 0) - COALESCE(b.energy, 0)) / COALESCE(b.energy, 0)) * 100, 2)
        ELSE NULL
      END AS pct_diff
    FROM a
    ${params.groupBy !== 'total' ? 'FULL OUTER JOIN b USING (' + params.groupBy + ')' : 'CROSS JOIN b'}
    ORDER BY diff_${params.unit.toLowerCase()} DESC NULLS LAST
    LIMIT ${MAX_RESULT_ROWS}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'compare_energy',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const compareEnergyTool: AnalyticsTool<CompareEnergyParams> = {
  name: 'compare_energy',
  description: 'Compare total energy between two product groups (e.g. IQ9N vs IQ8HC) or two site lists. Returns energy per group, difference, and percentage difference. Use for "IQ9N vs IQ8HC energy", "compare sites", "which performs better" questions.',
  parametersSchema: CompareEnergyParams,
  execute: executeCompareEnergy,
}

// ─── Tool 3: calculate_energy_per_inverter ────────────────────────────────────

const EnergyPerInverterParams = z.object({
  siteIds:  z.array(z.string()).optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
  topN:     z.number().int().min(1).max(MAX_RESULT_ROWS).default(50),
  orderBy:  z.enum(['asc', 'desc']).default('desc'),
})
type EnergyPerInverterParams = z.infer<typeof EnergyPerInverterParams>

async function executeEnergyPerInverter(params: EnergyPerInverterParams): Promise<ToolResult> {
  const started = Date.now()
  const siteF = buildSiteFilter(params.siteIds)
  const dateF = buildDateFilter(params.from, params.to)
  const order = params.orderBy.toUpperCase()

  const sql = `
    SELECT
      serial_number,
      site_id,
      sku_name,
      SUM(energy_produced)            AS total_energy_wh,
      SUM(energy_produced) / 1000.0   AS total_energy_kwh,
      COUNT(*)                        AS reading_count,
      CAST(MIN(timestamp) AS VARCHAR) AS first_reading,
      CAST(MAX(timestamp) AS VARCHAR) AS last_reading
    FROM telemetry
    WHERE 1=1 ${siteF} ${dateF}
    GROUP BY serial_number, site_id, sku_name
    ORDER BY total_energy_wh ${order} NULLS LAST
    LIMIT ${params.topN}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'calculate_energy_per_inverter',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
    },
  }
}

export const energyPerInverterTool: AnalyticsTool<EnergyPerInverterParams> = {
  name: 'calculate_energy_per_inverter',
  description: 'Per-microinverter energy ranking for a site or set of sites. Returns total energy (Wh/kWh), reading count, and date range per serial number. Use for "which inverter produced most", "inverter energy ranking", "top/bottom performing inverters".',
  parametersSchema: EnergyPerInverterParams,
  execute: executeEnergyPerInverter,
}

export const ENERGY_TOOLS = [
  calculateEnergyTool,
  compareEnergyTool,
  energyPerInverterTool,
] as const
