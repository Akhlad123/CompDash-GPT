// System Expansion (Project Lotto) analytics tool.
// Identifies sites with multiple microinverter generations — indicating
// that an older system (IQ6/IQ7) was expanded with newer hardware (IQ8/IQ9).
//
// Generation classification:
//   Gen 6: IQ6*
//   Gen 7: IQ7*
//   Gen 8: IQ8*
//   Gen 9: IQ9*
//
// A "system expansion" site has products from 2+ distinct generations.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import { buildFleetFilter } from '@/lib/fleetQueries'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'

// ─── Generation classifier SQL ──────────────────────────────────────────────

const GEN_CASE_SQL = `
  CASE
    WHEN UPPER(product_type) LIKE 'IQ6%' THEN 'Gen6'
    WHEN UPPER(product_type) LIKE 'IQ7%' THEN 'Gen7'
    WHEN UPPER(product_type) LIKE 'IQ8%' THEN 'Gen8'
    WHEN UPPER(product_type) LIKE 'IQ9%' THEN 'Gen9'
    ELSE 'Other'
  END
`.trim()

// ─── Parameters ─────────────────────────────────────────────────────────────

const SystemExpansionParams = z.object({
  mode: z.enum(['summary', 'details', 'trend']).default('summary'),
  filters: z.object({
    tssRegions:   z.array(z.string()).optional(),
    countries:    z.array(z.string()).optional(),
    quarters:     z.array(z.string()).optional(),
    tssCountries: z.array(z.string()).optional(),
  }).optional(),
  limit: z.number().int().min(1).max(MAX_RESULT_ROWS).default(50),
})
type SystemExpansionParams = z.infer<typeof SystemExpansionParams>

// ─── Execution ──────────────────────────────────────────────────────────────

async function executeSystemExpansion(params: SystemExpansionParams): Promise<ToolResult> {
  const started = Date.now()
  const where = buildFleetFilter({
    tssRegions:   params.filters?.tssRegions,
    countries:    params.filters?.countries,
    quarters:     params.filters?.quarters,
    tssCountries: params.filters?.tssCountries,
  })

  if (params.mode === 'summary') {
    // High-level count: how many sites have 2+ generations, broken down by region
    const sql = `
      WITH site_gens AS (
        SELECT
          site_id,
          MIN(tss_region) AS tss_region,
          MIN(country) AS country,
          COUNT(DISTINCT ${GEN_CASE_SQL}) AS gen_count,
          LIST(DISTINCT ${GEN_CASE_SQL} ORDER BY ${GEN_CASE_SQL}) AS generations,
          LIST(DISTINCT product_type ORDER BY product_type) AS product_types,
          SUM(unit_count) AS total_units
        FROM fleet
        WHERE product_type IS NOT NULL AND ${where}
        GROUP BY site_id
        HAVING gen_count >= 2
      )
      SELECT
        COALESCE(tss_region, 'Unknown') AS tss_region,
        COUNT(*) AS expanded_site_count,
        SUM(total_units) AS total_units,
        ROUND(AVG(gen_count), 1) AS avg_generations,
        LIST(DISTINCT unnested_gen ORDER BY unnested_gen) AS generations_seen
      FROM site_gens, LATERAL UNNEST(generations) AS t(unnested_gen)
      GROUP BY tss_region
      ORDER BY expanded_site_count DESC
    `.trim()

    const rows = await query<Record<string, unknown>>(sql)

    // Also get global total
    const totalSql = `
      WITH site_gens AS (
        SELECT site_id, COUNT(DISTINCT ${GEN_CASE_SQL}) AS gen_count
        FROM fleet
        WHERE product_type IS NOT NULL AND ${where}
        GROUP BY site_id
        HAVING gen_count >= 2
      )
      SELECT COUNT(*) AS total_expanded_sites FROM site_gens
    `.trim()
    const totalRows = await query<{ total_expanded_sites: number }>(totalSql)
    const totalExpanded = totalRows[0]?.total_expanded_sites ?? 0

    // Total sites for percentage
    const allSitesSql = `
      SELECT COUNT(DISTINCT site_id) AS total_sites
      FROM fleet
      WHERE product_type IS NOT NULL AND ${where}
    `.trim()
    const allSitesRows = await query<{ total_sites: number }>(allSitesSql)
    const totalSites = allSitesRows[0]?.total_sites ?? 0

    return {
      rows,
      metadata: {
        tool: 'get_system_expansion',
        params: params as unknown as Record<string, unknown>,
        sql,
        executionMs: Date.now() - started,
        rowCount: rows.length,
        warning: totalExpanded === 0
          ? 'No system expansion (Lotto) sites found in the current data.'
          : `${totalExpanded} sites out of ${totalSites} (${totalSites > 0 ? ((totalExpanded / totalSites) * 100).toFixed(1) : 0}%) have multiple microinverter generations (system expansion / Lotto). Would you like to see site-level details?`,
      },
    }
  }

  if (params.mode === 'details') {
    // Site-level detail: each expanded site with its generations, unit counts, region
    const sql = `
      WITH site_gens AS (
        SELECT
          site_id,
          MIN(tss_region) AS tss_region,
          MIN(country) AS country,
          MIN(state) AS state,
          MIN(city) AS city,
          COUNT(DISTINCT ${GEN_CASE_SQL}) AS gen_count,
          LIST(DISTINCT ${GEN_CASE_SQL} ORDER BY ${GEN_CASE_SQL}) AS generations,
          LIST(DISTINCT product_type ORDER BY product_type) AS microinverter_types,
          SUM(unit_count) AS total_units,
          MIN(quarter_first_interval) AS earliest_quarter,
          MAX(quarter_first_interval) AS latest_quarter
        FROM fleet
        WHERE product_type IS NOT NULL AND ${where}
        GROUP BY site_id
        HAVING gen_count >= 2
      )
      SELECT
        site_id,
        tss_region,
        country,
        state,
        city,
        gen_count AS generation_count,
        ARRAY_TO_STRING(generations, ', ') AS generations,
        ARRAY_TO_STRING(microinverter_types, ', ') AS microinverter_types,
        total_units,
        earliest_quarter,
        latest_quarter
      FROM site_gens
      ORDER BY gen_count DESC, total_units DESC
      LIMIT ${params.limit}
    `.trim()

    const rows = await query<Record<string, unknown>>(sql)
    return {
      rows,
      metadata: {
        tool: 'get_system_expansion',
        params: params as unknown as Record<string, unknown>,
        sql,
        executionMs: Date.now() - started,
        rowCount: rows.length,
        warning: rows.length === 0 ? 'No system expansion sites found.' : undefined,
      },
    }
  }

  // mode === 'trend'
  // Analyze expansion patterns: which old gen → new gen transitions, by region
  const sql = `
    WITH site_gens AS (
      SELECT
        site_id,
        MIN(tss_region) AS tss_region,
        MIN(country) AS country,
        LIST(DISTINCT ${GEN_CASE_SQL} ORDER BY ${GEN_CASE_SQL}) AS generations,
        LIST(DISTINCT product_type ORDER BY product_type) AS product_types,
        SUM(unit_count) AS total_units,
        COUNT(DISTINCT ${GEN_CASE_SQL}) AS gen_count
      FROM fleet
      WHERE product_type IS NOT NULL AND ${where}
      GROUP BY site_id
      HAVING gen_count >= 2
    ),
    expansion_pairs AS (
      SELECT
        tss_region,
        country,
        generations[1] AS original_gen,
        generations[ARRAY_LENGTH(generations)] AS newest_gen,
        ARRAY_TO_STRING(product_types, ', ') AS product_types,
        total_units
      FROM site_gens
    )
    SELECT
      COALESCE(tss_region, 'Unknown') AS tss_region,
      original_gen || ' → ' || newest_gen AS expansion_path,
      COUNT(*) AS site_count,
      SUM(total_units) AS total_units,
      LIST(DISTINCT country ORDER BY country) AS countries
    FROM expansion_pairs
    GROUP BY tss_region, original_gen, newest_gen
    ORDER BY site_count DESC
    LIMIT ${params.limit}
  `.trim()

  const rows = await query<Record<string, unknown>>(sql)
  return {
    rows,
    metadata: {
      tool: 'get_system_expansion',
      params: params as unknown as Record<string, unknown>,
      sql,
      executionMs: Date.now() - started,
      rowCount: rows.length,
      warning: rows.length === 0 ? 'No expansion trends found.' : undefined,
    },
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const systemExpansionTool: AnalyticsTool<SystemExpansionParams> = {
  name: 'get_system_expansion',
  description:
    'Analyze system expansion (Project Lotto) sites — sites where an older microinverter generation (IQ6/IQ7) ' +
    'was upgraded or expanded with a newer generation (IQ8/IQ9). ' +
    'Three modes: "summary" returns regional counts of expanded sites, ' +
    '"details" returns site-level breakdown with microinverter types and unit counts, ' +
    '"trend" analyzes expansion patterns (which generation transitions are most common, by region). ' +
    'Use for "system expansion", "lotto", "expanded sites", "multi-generation sites", "upgraded systems", ' +
    '"sites with IQ7 and IQ9", "how many sites have been expanded" questions.',
  parametersSchema: SystemExpansionParams,
  execute: executeSystemExpansion,
}
