// System Expansion (Project Lotto) analytics tool.
// Identifies sites where an IQ7-series system was expanded with IQ8 or IQ9
// hardware under the same site_id.
//
// DEFINITION: A site qualifies as "system expansion" / "Lotto" ONLY if it has:
//   - At least one IQ7-series product (IQ7*), AND
//   - At least one IQ8-series or IQ9-series product (IQ8* or IQ9*)
//
// Sites with only IQ8+IQ9 (no IQ7) do NOT qualify.
// Sites with only IQ6+IQ7 (no IQ8/IQ9) do NOT qualify.
// IQ6 is NOT considered as a qualifying old-gen for Lotto.
//
// IMPORTANT: The fleet table has multiple rows per (site_id, product_type)
// across quarters. We deduplicate to one row per (site_id, product_type) first
// using MAX(unit_count) to avoid inflated counts.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import { buildFleetFilter } from '@/lib/fleetQueries'
import type { AnalyticsTool, ToolResult } from './types'
import { MAX_RESULT_ROWS } from './types'

// ─── Lotto qualification CTE (reused by all modes) ─────────────────────────
// Step 1: Deduplicate fleet rows to one per (site_id, product_type).
// Step 2: Classify as old (IQ7) or new (IQ8/IQ9).
// Step 3: Keep only sites that have BOTH old AND new.

function buildLottoCTE(whereClause: string): string {
  return `
    deduped AS (
      SELECT
        site_id,
        product_type,
        MIN(tss_region) AS tss_region,
        MIN(country) AS country,
        MIN(state) AS state,
        MIN(city) AS city,
        MAX(unit_count) AS unit_count,
        MIN(quarter_first_interval) AS earliest_quarter,
        MAX(quarter_first_interval) AS latest_quarter
      FROM fleet
      WHERE product_type IS NOT NULL AND ${whereClause}
      GROUP BY site_id, product_type
    ),
    lotto_base AS (
      SELECT
        *,
        CASE
          WHEN UPPER(product_type) LIKE 'IQ7%' THEN 'old'
          WHEN UPPER(product_type) LIKE 'IQ8%' OR UPPER(product_type) LIKE 'IQ9%' THEN 'new'
          ELSE NULL
        END AS gen_class,
        CASE
          WHEN UPPER(product_type) LIKE 'IQ7%' THEN 'IQ7'
          WHEN UPPER(product_type) LIKE 'IQ8%' THEN 'IQ8'
          WHEN UPPER(product_type) LIKE 'IQ9%' THEN 'IQ9'
          ELSE 'Other'
        END AS gen_family
      FROM deduped
    ),
    site_qualification AS (
      SELECT
        site_id,
        MAX(CASE WHEN gen_class = 'old' THEN 1 ELSE 0 END) AS has_old,
        MAX(CASE WHEN gen_class = 'new' THEN 1 ELSE 0 END) AS has_new
      FROM lotto_base
      WHERE gen_class IS NOT NULL
      GROUP BY site_id
      HAVING has_old = 1 AND has_new = 1
    ),
    lotto_sites AS (
      SELECT b.*
      FROM lotto_base b
      INNER JOIN site_qualification sq ON b.site_id = sq.site_id
      WHERE b.gen_class IS NOT NULL
    )
  `.trim()
}

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
  const cte = buildLottoCTE(where)

  if (params.mode === 'summary') {
    const sql = `
      WITH ${cte}
      SELECT
        COALESCE(tss_region, 'Unknown') AS tss_region,
        COUNT(DISTINCT site_id) AS expanded_site_count,
        SUM(CASE WHEN gen_class = 'old' THEN unit_count ELSE 0 END) AS old_gen_units,
        SUM(CASE WHEN gen_class = 'new' THEN unit_count ELSE 0 END) AS new_gen_units,
        SUM(unit_count) AS total_units,
        LIST(DISTINCT gen_family ORDER BY gen_family) AS generation_families
      FROM lotto_sites
      GROUP BY tss_region
      ORDER BY expanded_site_count DESC
    `.trim()

    const rows = await query<Record<string, unknown>>(sql)

    // Global totals
    const totalSql = `
      WITH ${cte}
      SELECT COUNT(DISTINCT site_id) AS total_expanded_sites FROM lotto_sites
    `.trim()
    const totalRows = await query<{ total_expanded_sites: number }>(totalSql)
    const totalExpanded = totalRows[0]?.total_expanded_sites ?? 0

    const allSitesSql = `
      SELECT COUNT(DISTINCT site_id) AS total_sites
      FROM fleet WHERE product_type IS NOT NULL AND ${where}
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
          ? 'No system expansion (Lotto) sites found. Lotto = sites with IQ7 AND IQ8/IQ9 under the same site ID.'
          : `${totalExpanded} Lotto sites out of ${totalSites} total (${totalSites > 0 ? ((totalExpanded / totalSites) * 100).toFixed(1) : 0}%). These sites originally had IQ7-series microinverters and were expanded with IQ8/IQ9. Would you like to see site-level details?`,
      },
    }
  }

  if (params.mode === 'details') {
    const sql = `
      WITH ${cte},
      site_detail AS (
        SELECT
          site_id,
          MIN(tss_region) AS tss_region,
          MIN(country) AS country,
          MIN(state) AS state,
          MIN(city) AS city,
          LIST(DISTINCT gen_family ORDER BY gen_family) AS generation_families,
          LIST(DISTINCT product_type ORDER BY product_type) AS microinverter_types,
          SUM(CASE WHEN gen_class = 'old' THEN unit_count ELSE 0 END) AS old_gen_units,
          SUM(CASE WHEN gen_class = 'new' THEN unit_count ELSE 0 END) AS new_gen_units,
          SUM(unit_count) AS total_units,
          MIN(earliest_quarter) AS earliest_quarter,
          MAX(latest_quarter) AS latest_quarter
        FROM lotto_sites
        GROUP BY site_id
      )
      SELECT
        site_id,
        tss_region,
        country,
        state,
        city,
        ARRAY_TO_STRING(generation_families, ', ') AS generation_families,
        ARRAY_TO_STRING(microinverter_types, ', ') AS microinverter_types,
        old_gen_units,
        new_gen_units,
        total_units,
        earliest_quarter,
        latest_quarter
      FROM site_detail
      ORDER BY total_units DESC
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
        warning: rows.length === 0 ? 'No Lotto sites found.' : undefined,
      },
    }
  }

  // mode === 'trend'
  // Which old-gen → new-gen transitions are most common, by region
  const sql = `
    WITH ${cte},
    old_gens AS (
      SELECT DISTINCT site_id, gen_family AS old_family
      FROM lotto_sites WHERE gen_class = 'old'
    ),
    new_gens AS (
      SELECT DISTINCT site_id, gen_family AS new_family
      FROM lotto_sites WHERE gen_class = 'new'
    ),
    transitions AS (
      SELECT
        o.site_id,
        o.old_family,
        n.new_family,
        MIN(ls.tss_region) AS tss_region,
        MIN(ls.country) AS country
      FROM old_gens o
      JOIN new_gens n ON o.site_id = n.site_id
      JOIN lotto_sites ls ON ls.site_id = o.site_id
      GROUP BY o.site_id, o.old_family, n.new_family
    )
    SELECT
      COALESCE(tss_region, 'Unknown') AS tss_region,
      old_family || ' → ' || new_family AS expansion_path,
      COUNT(DISTINCT site_id) AS site_count,
      LIST(DISTINCT country ORDER BY country) AS countries
    FROM transitions
    GROUP BY tss_region, old_family, new_family
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
      warning: rows.length === 0 ? 'No Lotto expansion trends found.' : undefined,
    },
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const systemExpansionTool: AnalyticsTool<SystemExpansionParams> = {
  name: 'get_system_expansion',
  description:
    'Analyze system expansion (Project Lotto) sites — sites where an IQ7-series system ' +
    'was expanded with IQ8 or IQ9 microinverters on the same site ID. ' +
    'Three modes: "summary" returns regional counts of expanded sites, ' +
    '"details" returns site-level breakdown with microinverter types and unit counts, ' +
    '"trend" analyzes expansion patterns (which generation transitions are most common, by region). ' +
    'Use for "system expansion", "lotto", "expanded sites", "multi-generation sites", "upgraded systems", ' +
    '"sites with IQ7 and IQ9", "how many sites have been expanded" questions.',
  parametersSchema: SystemExpansionParams,
  execute: executeSystemExpansion,
}
