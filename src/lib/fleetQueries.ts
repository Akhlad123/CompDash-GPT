// Named SQL query constants for the `fleet` table. Params are interpolated
// by the calling hook via buildFleetFilter() — see fleetDuckdb usage sites.

import {
  CIRCUIT_PHASE_SINGLE_RESTRICTED,
  THREE_PHASE_RESTRICTED,
  sqlModelList,
  sqlInverterLimitsValues,
} from './complianceRules'

export interface FleetFilters {
  quarters?: string[]
  regions?: string[]
  /** TSS region (EURO/EMKT/LATAM/ANZP/etc.) */
  tssRegions?: string[]
  /** TSS country/sub-region (e.g. "Belgium", "Rest of EURO") */
  tssCountries?: string[]
  /** Full country name (e.g. "Germany", "Australia") — used with REGION_BUNDLES on the chart-replica page. */
  countries?: string[]
}

function sqlList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')
}

/** Exclude the "Not Available" sentinel that appears in the raw Excel data. */
const EXCLUDE_NOT_AVAILABLE = `tss_region != 'Not Available'`

/** Builds a WHERE clause fragment (no leading WHERE) from FleetFilters, or '1=1' if empty. */
export function buildFleetFilter(filters: FleetFilters): string {
  const clauses: string[] = [
    // Always exclude "Not Available" sentinel rows
    `(tss_region IS NULL OR ${EXCLUDE_NOT_AVAILABLE})`,
  ]
  if (filters.quarters && filters.quarters.length > 0) {
    clauses.push(`quarter_first_interval IN (${sqlList(filters.quarters)})`)
  }
  if (filters.regions && filters.regions.length > 0) {
    clauses.push(`region_bundle IN (${sqlList(filters.regions)})`)
  }
  if (filters.tssRegions && filters.tssRegions.length > 0) {
    clauses.push(`tss_region IN (${sqlList(filters.tssRegions)})`)
  }
  if (filters.tssCountries && filters.tssCountries.length > 0) {
    clauses.push(`tss_country IN (${sqlList(filters.tssCountries)})`)
  }
  if (filters.countries && filters.countries.length > 0) {
    clauses.push(`country IN (${sqlList(filters.countries)})`)
  }
  return clauses.join(' AND ')
}

/** SQL fragment for a row's usable-module-data flag. Mirrors hasModuleData() in fleetRegions.ts. */
export const HAS_MODULE_DATA_SQL =
  `(stc_rating2 IS NOT NULL AND stc_rating2 > 0 AND module_wafer IS NOT NULL AND module_wafer NOT IN ('No data', 'No check', ''))`

/** Aggregation expression: SUM(unit_count) for 'units', COUNT(DISTINCT site_id) for 'sites'. */
export function aggExpr(mode: 'units' | 'sites'): string {
  return mode === 'sites' ? 'COUNT(DISTINCT site_id)' : 'SUM(unit_count)'
}

export const FLEET_DISTINCT_TSS_REGIONS = `
  SELECT DISTINCT tss_region AS tss_region
  FROM fleet
  WHERE tss_region IS NOT NULL AND tss_region != '' AND ${EXCLUDE_NOT_AVAILABLE}
  ORDER BY tss_region
`

export const FLEET_DISTINCT_TSS_COUNTRIES = (tssRegions: string[]) => `
  SELECT DISTINCT tss_country AS tss_country
  FROM fleet
  WHERE tss_country IS NOT NULL AND tss_country != '' AND ${EXCLUDE_NOT_AVAILABLE}
  ${tssRegions.length > 0 ? `AND tss_region IN (${sqlList(tssRegions)})` : ''}
  ORDER BY tss_country
`

/**
 * Region summary keyed by tss_region (the primary "Region" filter). Weighted
 * avg/median/p75 STC rating and avg DC/AC ratio exclude rows without usable
 * module data — mirrors build_region_stats()/_weighted_quantile() in
 * "Fleet data Q1 and Q2-26 analytics.py".
 */
export const FLEET_REGION_SUMMARY = (where: string, mode: 'units' | 'sites' = 'units') => `
  WITH base AS (
    SELECT *, ${HAS_MODULE_DATA_SQL} AS has_data
    FROM fleet
    WHERE tss_region IS NOT NULL AND ${where}
  ),
  agg AS (
    SELECT
      tss_region,
      COUNT(DISTINCT site_id)                                       AS site_count,
      ${aggExpr(mode)}                                               AS total_units,
      SUM(CASE WHEN has_data THEN unit_count ELSE 0 END)             AS units_with,
      SUM(CASE WHEN NOT has_data THEN unit_count ELSE 0 END)         AS units_without,
      SUM(stc_mwdc)                                                  AS total_stc_mwdc,
      SUM(mwac)                                                      AS total_mwac,
      SUM(CASE WHEN has_data THEN stc_rating2 * unit_count ELSE 0 END)
        / NULLIF(SUM(CASE WHEN has_data THEN unit_count ELSE 0 END), 0) AS avg_stc_rating,
      AVG(CASE WHEN has_data THEN dc_ac_ratio END)                   AS avg_dc_ac
    FROM base
    GROUP BY tss_region
  ),
  quant AS (
    SELECT
      tss_region,
      stc_rating2,
      SUM(unit_count) OVER (PARTITION BY tss_region ORDER BY stc_rating2 ROWS UNBOUNDED PRECEDING) AS cum_units,
      SUM(unit_count) OVER (PARTITION BY tss_region) AS with_data_units
    FROM base
    WHERE has_data
  ),
  quantiles AS (
    SELECT
      tss_region,
      MIN(CASE WHEN cum_units >= 0.5 * with_data_units THEN stc_rating2 END)  AS median_stc,
      MIN(CASE WHEN cum_units >= 0.75 * with_data_units THEN stc_rating2 END) AS p75_stc
    FROM quant
    GROUP BY tss_region
  )
  SELECT a.*, q.median_stc, q.p75_stc
  FROM agg a
  LEFT JOIN quantiles q USING (tss_region)
  ORDER BY a.total_units DESC
`

export const FLEET_WAFER_SHARE_BY_TSS_REGION = (where: string, mode: 'units' | 'sites' = 'units') => `
  SELECT
    tss_region,
    module_wafer,
    ${aggExpr(mode)} AS units
  FROM fleet
  WHERE tss_region IS NOT NULL AND module_wafer IS NOT NULL AND ${where}
  GROUP BY tss_region, module_wafer
`

export const FLEET_WAFER_SHARE_BY_REGION = (where: string, mode: 'units' | 'sites' = 'units') => `
  SELECT
    region_bundle,
    module_wafer,
    ${aggExpr(mode)} AS units
  FROM fleet
  WHERE region_bundle IS NOT NULL AND module_wafer IS NOT NULL AND ${where}
  GROUP BY region_bundle, module_wafer
  ORDER BY region_bundle, units DESC
`

export const FLEET_WAFER_DETAIL_BY_REGION = (
  region: string, where: string, mode: 'units' | 'sites' = 'units', powerBlockExpr: string = 'power_block'
) => `
  SELECT
    module_wafer,
    ${powerBlockExpr} AS power_block,
    ${aggExpr(mode)} AS units
  FROM fleet
  WHERE region_bundle = '${region.replace(/'/g, "''")}'
    AND module_wafer IS NOT NULL
    AND ${powerBlockExpr} IS NOT NULL
    AND ${where}
  GROUP BY module_wafer, ${powerBlockExpr}
  ORDER BY module_wafer, ${powerBlockExpr}
`

export const FLEET_WAFER_DETAIL_BY_TSS_REGION = (
  tssRegion: string, where: string, mode: 'units' | 'sites' = 'units', powerBlockExpr: string = 'power_block'
) => `
  SELECT
    module_wafer,
    ${powerBlockExpr} AS power_block,
    ${aggExpr(mode)} AS units
  FROM fleet
  WHERE tss_region = '${tssRegion.replace(/'/g, "''")}'
    AND module_wafer IS NOT NULL
    AND ${powerBlockExpr} IS NOT NULL
    AND ${where}
  GROUP BY module_wafer, ${powerBlockExpr}
  ORDER BY module_wafer, ${powerBlockExpr}
`

export const FLEET_PRODUCT_BUCKET_BY_TSS_REGION = (where: string) => `
  SELECT
    tss_region,
    power_bucket,
    SUM(unit_count) AS units
  FROM fleet
  WHERE tss_region IS NOT NULL AND power_bucket IS NOT NULL AND ${where}
  GROUP BY tss_region, power_bucket
  ORDER BY tss_region, power_bucket
`

export const FLEET_PRODUCT_BUCKET_BY_TSS_COUNTRY = (where: string) => `
  SELECT
    tss_country,
    power_bucket,
    SUM(unit_count) AS units
  FROM fleet
  WHERE tss_country IS NOT NULL AND power_bucket IS NOT NULL AND ${where}
  GROUP BY tss_country, power_bucket
  ORDER BY tss_country, power_bucket
`

/** Sites/units with vs. without usable module data — used by Fleet Overview summary. */
export const FLEET_MODULE_DATA_SUMMARY = (where: string) => `
  SELECT
    CASE WHEN ${HAS_MODULE_DATA_SQL} THEN 'with_data' ELSE 'without_data' END AS bucket,
    COUNT(DISTINCT site_id) AS sites,
    SUM(unit_count)         AS units
  FROM fleet
  WHERE ${where}
  GROUP BY bucket
`

export const FLEET_DISTINCT_PRODUCT_TYPES = `
  SELECT DISTINCT product_type AS product_type
  FROM fleet
  WHERE product_type IS NOT NULL
  ORDER BY product_type
`

/**
 * Pivot source: product_type x power_bucket, split by module-data availability,
 * for the revamped Product Bucket page. Aggregated by units or sites.
 */
export const FLEET_PRODUCT_TYPE_BY_BUCKET = (
  where: string, mode: 'units' | 'sites' = 'units', bucketExpr: string = 'power_bucket'
) => `
  SELECT
    product_type,
    CASE WHEN ${HAS_MODULE_DATA_SQL} THEN ${bucketExpr} ELSE 'No module data' END AS bucket_label,
    ${aggExpr(mode)} AS value
  FROM fleet
  WHERE product_type IS NOT NULL AND ${where}
  GROUP BY product_type, bucket_label
  ORDER BY product_type, bucket_label
`

/**
 * Module-make breakdown for the revamped Product Bucket page. Average Power (W)
 * excludes rows without module data so the average isn't skewed toward 0.
 */
export const FLEET_MODULE_MAKE_BREAKDOWN = (where: string, mode: 'units' | 'sites' = 'units') => `
  SELECT
    CASE WHEN ${HAS_MODULE_DATA_SQL} THEN pv_module_make ELSE 'No module data' END AS pv_module_make,
    ${aggExpr(mode)} AS value,
    SUM(CASE WHEN ${HAS_MODULE_DATA_SQL} THEN stc_rating2 * unit_count ELSE 0 END)
      / NULLIF(SUM(CASE WHEN ${HAS_MODULE_DATA_SQL} THEN unit_count ELSE 0 END), 0) AS avg_power_w
  FROM fleet
  WHERE ${where}
  GROUP BY CASE WHEN ${HAS_MODULE_DATA_SQL} THEN pv_module_make ELSE 'No module data' END
  ORDER BY value DESC
`

/**
 * Region x Power Block x Wafer x Product Type breakdown keyed by tss_region,
 * restricted to rows with usable module data AND a known wafer (WAFER_ORDER).
 * power_block is computed dynamically via the supplied powerBlockExpr so that
 * the UI can recompute bins per TSS region without re-ingesting data.
 */
export const FLEET_CHART_BLOCK_DATA = (where: string, waferList: string[], powerBlockExpr: string = 'power_block') => `
  SELECT
    tss_region,
    ${powerBlockExpr} AS power_block,
    module_wafer,
    product_type,
    SUM(unit_count) AS units
  FROM fleet
  WHERE tss_region IS NOT NULL
    AND ${powerBlockExpr} IS NOT NULL
    AND module_wafer IN (${sqlList(waferList)})
    AND ${where}
  GROUP BY tss_region, ${powerBlockExpr}, module_wafer, product_type
`

/** Region-level stats (with/without module data, weighted avg/median/p75 power, DC/AC, MWdc) keyed by tss_region. */
export const FLEET_CHART_REGION_STATS = (where: string) => `
  WITH base AS (
    SELECT *, ${HAS_MODULE_DATA_SQL} AS has_data
    FROM fleet
    WHERE tss_region IS NOT NULL AND ${where}
  ),
  agg AS (
    SELECT
      tss_region,
      COUNT(DISTINCT CASE WHEN has_data THEN site_id END) AS sites_with,
      COUNT(DISTINCT CASE WHEN NOT has_data THEN site_id END) AS sites_without,
      SUM(CASE WHEN has_data THEN unit_count ELSE 0 END) AS units_with,
      SUM(CASE WHEN NOT has_data THEN unit_count ELSE 0 END) AS units_without,
      SUM(CASE WHEN has_data THEN stc_rating2 * unit_count ELSE 0 END)
        / NULLIF(SUM(CASE WHEN has_data THEN unit_count ELSE 0 END), 0) AS avg_power_w,
      AVG(CASE WHEN has_data THEN dc_ac_ratio END) AS avg_dc_ac,
      SUM(CASE WHEN has_data THEN stc_mwdc ELSE 0 END) AS mw_dc
    FROM base
    GROUP BY tss_region
  ),
  quant AS (
    SELECT
      tss_region,
      stc_rating2,
      SUM(unit_count) OVER (PARTITION BY tss_region ORDER BY stc_rating2 ROWS UNBOUNDED PRECEDING) AS cum_units,
      SUM(unit_count) OVER (PARTITION BY tss_region) AS with_data_units
    FROM base
    WHERE has_data
  ),
  quantiles AS (
    SELECT
      tss_region,
      MIN(CASE WHEN cum_units >= 0.5 * with_data_units THEN stc_rating2 END)  AS median_stc,
      MIN(CASE WHEN cum_units >= 0.75 * with_data_units THEN stc_rating2 END) AS p75_stc
    FROM quant
    GROUP BY tss_region
  )
  SELECT a.*, q.median_stc, q.p75_stc
  FROM agg a
  LEFT JOIN quantiles q USING (tss_region)
`

export const FLEET_SITE_LOOKUP = (siteId: string) => `
  SELECT *
  FROM fleet
  WHERE site_id = '${siteId.replace(/'/g, "''")}'
`

export const FLEET_DISTINCT_QUARTERS = `
  SELECT DISTINCT quarter_first_interval AS quarter
  FROM fleet
  WHERE quarter_first_interval IS NOT NULL
  ORDER BY quarter
`

export const FLEET_DISTINCT_REGIONS = `
  SELECT DISTINCT region_bundle AS region
  FROM fleet
  WHERE region_bundle IS NOT NULL
  ORDER BY region
`

// ---------------------------------------------------------------------------
// Transition Analytics queries
// ---------------------------------------------------------------------------

/**
 * Builds a SQL expression that maps quarter_first_interval to a time bucket.
 * 'quarterly' → as-is, 'half-yearly' → 'YYYY - H1/H2', 'yearly' → 'YYYY'
 */
export function timeBucketExpr(resolution: 'quarterly' | 'half-yearly' | 'yearly'): string {
  if (resolution === 'yearly')
    return `LEFT(quarter_first_interval, 4)`
  if (resolution === 'half-yearly')
    return `LEFT(quarter_first_interval, 4) || CASE WHEN RIGHT(quarter_first_interval, 2) IN ('Q1','Q2') THEN ' - H1' ELSE ' - H2' END`
  return `quarter_first_interval`
}

/** Wafer share (unit count) per time bucket */
export const FLEET_TRANSITION_WAFER = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    module_wafer,
    SUM(unit_count) AS units
  FROM fleet
  WHERE module_wafer IS NOT NULL
    AND module_wafer NOT IN ('No data', 'No check', '')
    AND ${where}
  GROUP BY period, tss_region, module_wafer
  ORDER BY period, module_wafer
`

/** Weighted avg module power per time bucket */
export const FLEET_TRANSITION_POWER = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    SUM(stc_rating2 * unit_count) / NULLIF(SUM(unit_count), 0) AS avg_power_w,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY stc_rating2) AS median_power_w,
    SUM(unit_count) AS units
  FROM fleet
  WHERE ${HAS_MODULE_DATA_SQL} AND ${where}
  GROUP BY period, tss_region
  ORDER BY period
`

/** Weighted avg DC/AC ratio per time bucket */
export const FLEET_TRANSITION_DCAC = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    SUM(dc_ac_ratio * unit_count) / NULLIF(SUM(unit_count), 0) AS avg_dc_ac,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dc_ac_ratio) AS median_dc_ac,
    SUM(unit_count) AS units
  FROM fleet
  WHERE dc_ac_ratio IS NOT NULL AND dc_ac_ratio > 0 AND dc_ac_ratio < 5 AND ${where}
  GROUP BY period, tss_region
  ORDER BY period
`

/** Product type mix (unit count) per time bucket — top N types */
export const FLEET_TRANSITION_PRODUCT_TYPE = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    product_type,
    SUM(unit_count) AS units
  FROM fleet
  WHERE product_type IS NOT NULL AND ${where}
  GROUP BY period, tss_region, product_type
  ORDER BY period, units DESC
`

/** Top module makes per time bucket */
export const FLEET_TRANSITION_MODULE_MAKE = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    COALESCE(pv_module_make, 'Unknown') AS pv_module_make,
    SUM(unit_count) AS units
  FROM fleet
  WHERE ${HAS_MODULE_DATA_SQL} AND ${where}
  GROUP BY period, tss_region, pv_module_make
  ORDER BY period, units DESC
`

/** Power bucket distribution per time bucket */
export const FLEET_TRANSITION_POWER_BUCKET = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    power_bucket,
    SUM(unit_count) AS units
  FROM fleet
  WHERE power_bucket IS NOT NULL AND ${HAS_MODULE_DATA_SQL} AND ${where}
  GROUP BY period, tss_region, power_bucket
  ORDER BY period, power_bucket
`

/** Growth metrics: total units, sites, MWdc per time bucket */
export const FLEET_TRANSITION_GROWTH = (where: string, bucketExpr: string) => `
  SELECT
    ${bucketExpr} AS period,
    tss_region,
    SUM(unit_count) AS total_units,
    COUNT(DISTINCT site_id) AS total_sites,
    SUM(stc_mwdc) AS total_mwdc,
    SUM(mwac) AS total_mwac
  FROM fleet
  WHERE ${where}
  GROUP BY period, tss_region
  ORDER BY period
`

// ─── Compliance Queries ──────────────────────────────────────────────────────

/**
 * Category 1 — Circuit Phase violation (NA only).
 * Listed model_names on SinglePhase circuit are non-compliant.
 */
export const COMPLIANCE_CIRCUIT_PHASE = (where: string) => `
  SELECT
    site_id,
    country,
    tss_region,
    tss_country,
    state,
    city,
    product_type,
    model_name,
    circuit_phase,
    pv_module_make,
    pv_module_model,
    SUM(unit_count) AS unit_count
  FROM fleet
  WHERE tss_region = 'NA'
    AND LOWER(circuit_phase) = 'singlephase'
    AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
    AND ${where}
  GROUP BY site_id, country, tss_region, tss_country, state, city,
           product_type, model_name, circuit_phase, pv_module_make, pv_module_model
  ORDER BY unit_count DESC
`

/**
 * Category 2 — Three-Phase EIM violation (NA only).
 * Listed model_names on systems where Production or Consumption EIM config
 * starts with "Three" are non-compliant.
 */
export const COMPLIANCE_THREE_PHASE = (where: string) => `
  SELECT
    site_id,
    country,
    tss_region,
    tss_country,
    state,
    city,
    product_type,
    model_name,
    production_eim_config,
    consumption_eim_config,
    pv_module_make,
    pv_module_model,
    SUM(unit_count) AS unit_count
  FROM fleet
  WHERE tss_region = 'NA'
    AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
    AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
    AND ${where}
  GROUP BY site_id, country, tss_region, tss_country, state, city,
           product_type, model_name, production_eim_config, consumption_eim_config,
           pv_module_make, pv_module_model
  ORDER BY unit_count DESC
`

/**
 * Category 3 — Module electrical compatibility (all regions).
 * Accepts vocTempC (default −40) and iscTempC (default 60) so the user
 * can tweak the evaluation temperature via sliders.
 *
 * Formulae:
 *   Voc@X = Voc + Voc × (−0.25/100) × (X − 25)  =  Voc × (1 + (−0.0025) × (X − 25))
 *   Isc@Y = Isc + Isc × ( 0.04/100) × (Y − 25)  =  Isc × (1 + ( 0.0004) × (Y − 25))
 */
export const COMPLIANCE_MODULE_LIMITS = (
  where: string,
  vocTempC: number = -40,
  iscTempC: number = 60,
) => {
  const vocFactor = (1 + (-0.0025) * (vocTempC - 25)).toFixed(6)
  const iscFactor = (1 + ( 0.0004) * (iscTempC - 25)).toFixed(6)
  return `
  WITH inv_limits(inv_product_type, max_voc, max_isc) AS (
    VALUES ${sqlInverterLimitsValues()}
  )
  SELECT
    f.site_id,
    f.country,
    f.tss_region,
    f.tss_country,
    f.state,
    f.city,
    f.product_type,
    f.model_name,
    f.pv_module_make,
    f.pv_module_model,
    f.voc,
    f.isc,
    ROUND(f.voc * ${vocFactor}, 2) AS voc_at_temp,
    ROUND(f.isc * ${iscFactor}, 3) AS isc_at_temp,
    il.max_voc,
    il.max_isc,
    CASE WHEN ROUND(f.voc * ${vocFactor}, 2) > il.max_voc THEN 1 ELSE 0 END AS voc_exceeded,
    CASE WHEN ROUND(f.isc * ${iscFactor}, 3) > il.max_isc THEN 1 ELSE 0 END AS isc_exceeded,
    SUM(f.unit_count) AS unit_count
  FROM fleet f
  JOIN inv_limits il
    ON UPPER(f.product_type) = UPPER(il.inv_product_type)
  WHERE f.voc IS NOT NULL AND f.isc IS NOT NULL
    AND f.voc > 0 AND f.isc > 0
    AND f.voc <= 120 AND f.isc <= 19
    AND UPPER(f.model_name) NOT LIKE '%BAT%'
    AND (ROUND(f.voc * ${vocFactor}, 2) > il.max_voc
         OR ROUND(f.isc * ${iscFactor}, 3) > il.max_isc)
    AND ${where}
  GROUP BY f.site_id, f.country, f.tss_region, f.tss_country, f.state, f.city,
           f.product_type, f.model_name, f.pv_module_make, f.pv_module_model,
           f.voc, f.isc, il.max_voc, il.max_isc
  ORDER BY unit_count DESC
`
}

// ─── RMA × Compliance correlation queries ────────────────────────────────────

/**
 * RMA correlation summary: for each compliance category, count how many
 * violation sites also have RMA records, total RMA replacements at those
 * sites, total fleet units at those sites, and DPPM.
 *
 * mode:
 *  - 'cat1'  = 208 L-L violations only
 *  - 'cat2'  = Three-Phase violations only
 *  - 'cat3'  = Module Compatibility violations only
 *  - 'all'   = union of sites from any violation category
 */
export const RMA_COMPLIANCE_CORRELATION = (
  where: string,
  mode: 'cat1' | 'cat2' | 'cat3' | 'all',
  vocTempC: number = -40,
  iscTempC: number = 60,
) => {
  const vocFactor = (1 + (-0.0025) * (vocTempC - 25)).toFixed(6)
  const iscFactor = (1 + ( 0.0004) * (iscTempC - 25)).toFixed(6)

  // CTEs that compute BOTH distinct violation site IDs AND the affected unit_count
  // so "units_affected" matches the compliance summary KPIs.
  const cat1CTE = `
    cat1_violations AS (
      SELECT site_id, SUM(unit_count) AS units
      FROM fleet
      WHERE tss_region = 'NA' AND LOWER(circuit_phase) = 'singlephase'
        AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
        AND ${where}
      GROUP BY site_id
    )`

  const cat2CTE = `
    cat2_violations AS (
      SELECT site_id, SUM(unit_count) AS units
      FROM fleet
      WHERE tss_region = 'NA'
        AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
        AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
        AND ${where}
      GROUP BY site_id
    )`

  const cat3CTE = `
    cat3_violations AS (
      SELECT f.site_id, SUM(f.unit_count) AS units
      FROM fleet f
      JOIN (VALUES ${sqlInverterLimitsValues()}) AS il(inv_product_type, max_voc, max_isc)
        ON UPPER(f.product_type) = UPPER(il.inv_product_type)
      WHERE f.voc IS NOT NULL AND f.isc IS NOT NULL
        AND f.voc > 0 AND f.isc > 0
        AND f.voc <= 120 AND f.isc <= 19
        AND UPPER(f.model_name) NOT LIKE '%BAT%'
        AND (ROUND(f.voc * ${vocFactor}, 2) > il.max_voc
             OR ROUND(f.isc * ${iscFactor}, 3) > il.max_isc)
        AND ${where}
      GROUP BY f.site_id
    )`

  let violationUnitsCTE: string
  let ctes: string[]

  switch (mode) {
    case 'cat1':
      ctes = [cat1CTE]
      violationUnitsCTE = 'violation_units AS (SELECT site_id, units FROM cat1_violations)'
      break
    case 'cat2':
      ctes = [cat2CTE]
      violationUnitsCTE = 'violation_units AS (SELECT site_id, units FROM cat2_violations)'
      break
    case 'cat3':
      ctes = [cat3CTE]
      violationUnitsCTE = 'violation_units AS (SELECT site_id, units FROM cat3_violations)'
      break
    case 'all':
      ctes = [cat1CTE, cat2CTE, cat3CTE]
      violationUnitsCTE = `violation_units AS (
        SELECT site_id, SUM(units) AS units FROM (
          SELECT site_id, units FROM cat1_violations
          UNION ALL SELECT site_id, units FROM cat2_violations
          UNION ALL SELECT site_id, units FROM cat3_violations
        ) GROUP BY site_id
      )`
      break
  }

  return `
    WITH
    ${ctes.join(',\n    ')},
    ${violationUnitsCTE},
    rma_counts AS (
      SELECT
        vu.site_id,
        COUNT(*) AS rma_count
      FROM violation_units vu
      JOIN rma r ON r.site_id = vu.site_id
        AND LOWER(r.rma_product_type) = 'microinverter'
      GROUP BY vu.site_id
    )
    SELECT
      (SELECT COUNT(*) FROM violation_units)             AS violation_sites,
      (SELECT COUNT(*) FROM rma_counts)                  AS sites_with_rma,
      COALESCE((SELECT SUM(rma_count) FROM rma_counts), 0) AS total_rmas,
      COALESCE((SELECT SUM(units) FROM violation_units), 0) AS units_affected,
      CASE
        WHEN COALESCE((SELECT SUM(units) FROM violation_units), 0) > 0
        THEN ROUND(
          COALESCE((SELECT SUM(rma_count) FROM rma_counts), 0) * 1000000.0
          / (SELECT SUM(units) FROM violation_units), 0)
        ELSE 0
      END                                                AS dppm
    FROM (SELECT 1) AS _dummy
  `.trim()
}

/**
 * Detailed RMA list for violation sites — used to populate the drill-down table.
 * Returns per-RMA row: site_id, state, country, product_type (from RMA),
 * returned_sku, replacement_model, fleet_units, rma_count_at_site,
 * module model, Voc, Isc, Voc@temp, Isc@temp, and violation flags.
 */
export const RMA_COMPLIANCE_DETAIL = (
  where: string,
  mode: 'cat1' | 'cat2' | 'cat3' | 'all',
  vocTempC: number = -40,
  iscTempC: number = 60,
) => {
  const vocFactor = (1 + (-0.0025) * (vocTempC - 25)).toFixed(6)
  const iscFactor = (1 + ( 0.0004) * (iscTempC - 25)).toFixed(6)

  const cat1CTE = `
    cat1_sites AS (
      SELECT DISTINCT site_id FROM fleet
      WHERE tss_region = 'NA' AND LOWER(circuit_phase) = 'singlephase'
        AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
        AND ${where}
    )`

  const cat2CTE = `
    cat2_sites AS (
      SELECT DISTINCT site_id FROM fleet
      WHERE tss_region = 'NA'
        AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
        AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
        AND ${where}
    )`

  const cat3CTE = `
    cat3_sites AS (
      SELECT DISTINCT f.site_id FROM fleet f
      JOIN (VALUES ${sqlInverterLimitsValues()}) AS il(inv_product_type, max_voc, max_isc)
        ON UPPER(f.product_type) = UPPER(il.inv_product_type)
      WHERE f.voc IS NOT NULL AND f.isc IS NOT NULL
        AND f.voc > 0 AND f.isc > 0
        AND f.voc <= 120 AND f.isc <= 19
        AND UPPER(f.model_name) NOT LIKE '%BAT%'
        AND (ROUND(f.voc * ${vocFactor}, 2) > il.max_voc
             OR ROUND(f.isc * ${iscFactor}, 3) > il.max_isc)
        AND ${where}
    )`

  // Always define all 3 CTEs so we can flag categories per site
  const ctes = [cat1CTE, cat2CTE, cat3CTE]

  let violationFilter: string
  switch (mode) {
    case 'cat1':
      violationFilter = 'WHERE c1.site_id IS NOT NULL'
      break
    case 'cat2':
      violationFilter = 'WHERE c2.site_id IS NOT NULL'
      break
    case 'cat3':
      violationFilter = 'WHERE c3.site_id IS NOT NULL'
      break
    case 'all':
      violationFilter = 'WHERE (c1.site_id IS NOT NULL OR c2.site_id IS NOT NULL OR c3.site_id IS NOT NULL)'
      break
  }

  return `
    WITH
    ${ctes.join(',\n    ')},
    all_violation_sites AS (
      SELECT DISTINCT site_id FROM (
        SELECT site_id FROM cat1_sites
        UNION ALL SELECT site_id FROM cat2_sites
        UNION ALL SELECT site_id FROM cat3_sites
      )
    ),
    site_rma_agg AS (
      SELECT
        avs.site_id,
        COUNT(*) AS rma_count,
        STRING_AGG(DISTINCT r.rma_product_type, ', ' ORDER BY r.rma_product_type) AS product_types,
        STRING_AGG(DISTINCT r.returned_sku, ', ' ORDER BY r.returned_sku) AS returned_skus,
        STRING_AGG(DISTINCT r.replacement_model, ', ' ORDER BY r.replacement_model) AS replacement_skus
      FROM all_violation_sites avs
      JOIN rma r ON r.site_id = avs.site_id
        AND LOWER(r.rma_product_type) = 'microinverter'
      GROUP BY avs.site_id
    ),
    site_fleet AS (
      SELECT
        f.site_id,
        f.country,
        f.tss_region,
        f.state,
        f.city,
        f.pv_module_model,
        f.voc,
        f.isc,
        ROUND(f.voc * ${vocFactor}, 2) AS voc_at_temp,
        ROUND(f.isc * ${iscFactor}, 3) AS isc_at_temp,
        SUM(f.unit_count) AS fleet_units
      FROM fleet f
      JOIN all_violation_sites avs ON f.site_id = avs.site_id
      WHERE ${where}
      GROUP BY f.site_id, f.country, f.tss_region, f.state, f.city,
               f.pv_module_model, f.voc, f.isc
    )
    SELECT
      sf.site_id,
      sf.state,
      sf.country,
      sr.product_types      AS product_type,
      sr.returned_skus      AS returned_sku,
      sr.replacement_skus   AS replacement_sku,
      sf.fleet_units,
      COALESCE(sr.rma_count, 0) AS rma_count,
      sf.pv_module_model,
      sf.voc,
      sf.voc_at_temp,
      sf.isc,
      sf.isc_at_temp,
      CASE WHEN c1.site_id IS NOT NULL THEN 1 ELSE 0 END AS cat1_fail,
      CASE WHEN c2.site_id IS NOT NULL THEN 1 ELSE 0 END AS cat2_fail,
      CASE WHEN c3.site_id IS NOT NULL THEN 1 ELSE 0 END AS cat3_fail
    FROM site_fleet sf
    LEFT JOIN site_rma_agg sr ON sf.site_id = sr.site_id
    LEFT JOIN cat1_sites c1 ON sf.site_id = c1.site_id
    LEFT JOIN cat2_sites c2 ON sf.site_id = c2.site_id
    LEFT JOIN cat3_sites c3 ON sf.site_id = c3.site_id
    ${violationFilter}
    ORDER BY sr.rma_count DESC NULLS LAST, sf.fleet_units DESC
    LIMIT 1000
  `.trim()
}

// ─── Section 3: Installation vs RMA Trend ────────────────────────────────────

/**
 * Half-year installation population vs RMA population for compliant and
 * non-compliant systems.  Returns one row per half-year with installation
 * and RMA counts for both groups plus derived RMA rate and DPPM.
 *
 * category: 'all' | 'cat1' | 'cat2' | 'cat3'
 *   - 'all' = non-compliant = site fails ANY of the 3 checks
 *   - 'cat1' / 'cat2' / 'cat3' = non-compliant = site fails that specific check
 */
export const COMPLIANCE_RMA_TREND = (
  where: string,
  category: 'all' | 'cat1' | 'cat2' | 'cat3',
  vocTempC: number = -40,
  iscTempC: number = 60,
) => {
  const vocFactor = (1 + (-0.0025) * (vocTempC - 25)).toFixed(6)
  const iscFactor = (1 + ( 0.0004) * (iscTempC - 25)).toFixed(6)

  // CTEs for each violation category (distinct site_id)
  const cat1CTE = `
    cat1_sites AS (
      SELECT DISTINCT site_id FROM fleet
      WHERE tss_region = 'NA' AND LOWER(circuit_phase) = 'singlephase'
        AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
        AND ${where}
    )`

  const cat2CTE = `
    cat2_sites AS (
      SELECT DISTINCT site_id FROM fleet
      WHERE tss_region = 'NA'
        AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
        AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
        AND ${where}
    )`

  const cat3CTE = `
    cat3_sites AS (
      SELECT DISTINCT f.site_id FROM fleet f
      JOIN (VALUES ${sqlInverterLimitsValues()}) AS il(inv_product_type, max_voc, max_isc)
        ON UPPER(f.product_type) = UPPER(il.inv_product_type)
      WHERE f.voc IS NOT NULL AND f.isc IS NOT NULL
        AND f.voc > 0 AND f.isc > 0
        AND f.voc <= 120 AND f.isc <= 19
        AND UPPER(f.model_name) NOT LIKE '%BAT%'
        AND (ROUND(f.voc * ${vocFactor}, 2) > il.max_voc
             OR ROUND(f.isc * ${iscFactor}, 3) > il.max_isc)
        AND ${where}
    )`

  // non-compliant site set depends on category
  let ncCTE: string
  switch (category) {
    case 'cat1':
      ncCTE = `nc_sites AS (SELECT site_id FROM cat1_sites)`
      break
    case 'cat2':
      ncCTE = `nc_sites AS (SELECT site_id FROM cat2_sites)`
      break
    case 'cat3':
      ncCTE = `nc_sites AS (SELECT site_id FROM cat3_sites)`
      break
    case 'all':
      ncCTE = `nc_sites AS (
        SELECT DISTINCT site_id FROM (
          SELECT site_id FROM cat1_sites
          UNION ALL SELECT site_id FROM cat2_sites
          UNION ALL SELECT site_id FROM cat3_sites
        )
      )`
      break
  }

  return `
    WITH
    ${cat1CTE},
    ${cat2CTE},
    ${cat3CTE},
    ${ncCTE},
    -- Derive half-year from quarter_first_interval (e.g. "2025 - Q1" → "H1-25")
    fleet_hy AS (
      SELECT
        f.site_id,
        CASE
          WHEN RIGHT(f.quarter_first_interval, 2) IN ('Q1','Q2')
          THEN 'H1-' || RIGHT(LEFT(f.quarter_first_interval, 4), 2)
          ELSE 'H2-' || RIGHT(LEFT(f.quarter_first_interval, 4), 2)
        END AS half_year,
        f.unit_count,
        CASE WHEN nc.site_id IS NOT NULL THEN 1 ELSE 0 END AS is_nc
      FROM fleet f
      LEFT JOIN nc_sites nc ON f.site_id = nc.site_id
      WHERE f.quarter_first_interval IS NOT NULL AND ${where}
    ),
    -- Aggregate installations per half-year
    inst AS (
      SELECT
        half_year,
        SUM(CASE WHEN is_nc = 0 THEN unit_count ELSE 0 END) AS compliant_inst,
        SUM(CASE WHEN is_nc = 1 THEN unit_count ELSE 0 END) AS nc_inst,
        COUNT(DISTINCT CASE WHEN is_nc = 0 THEN site_id END) AS compliant_sites,
        COUNT(DISTINCT CASE WHEN is_nc = 1 THEN site_id END) AS nc_sites
      FROM fleet_hy
      GROUP BY half_year
    ),
    -- All fleet site IDs (for RMA filtering — only include RMAs whose site exists in fleet)
    fleet_site_ids AS (
      SELECT DISTINCT CAST(site_id AS VARCHAR) AS site_id FROM fleet WHERE ${where}
    ),
    -- Derive half-year from rma_quarter (format: "2024Q1", "2025Q3", etc.)
    rma_hy AS (
      SELECT
        r.site_id,
        CASE
          WHEN RIGHT(r.rma_quarter, 2) IN ('Q1','Q2')
          THEN 'H1-' || RIGHT(LEFT(r.rma_quarter, 4), 2)
          ELSE 'H2-' || RIGHT(LEFT(r.rma_quarter, 4), 2)
        END AS half_year,
        CASE WHEN nc.site_id IS NOT NULL THEN 1 ELSE 0 END AS is_nc
      FROM rma r
      JOIN fleet_site_ids fsi ON CAST(r.site_id AS VARCHAR) = fsi.site_id
      LEFT JOIN nc_sites nc ON CAST(r.site_id AS VARCHAR) = CAST(nc.site_id AS VARCHAR)
      WHERE LOWER(r.rma_product_type) = 'microinverter'
        AND r.rma_quarter IS NOT NULL
        AND LENGTH(r.rma_quarter) >= 5
    ),
    -- Aggregate RMAs per half-year
    rma_agg AS (
      SELECT
        half_year,
        SUM(CASE WHEN is_nc = 0 THEN 1 ELSE 0 END) AS compliant_rma,
        SUM(CASE WHEN is_nc = 1 THEN 1 ELSE 0 END) AS nc_rma
      FROM rma_hy
      GROUP BY half_year
    ),
    -- All half-year periods
    all_periods AS (
      SELECT half_year FROM inst
      UNION
      SELECT half_year FROM rma_agg
    )
    SELECT
      p.half_year,
      COALESCE(i.compliant_inst, 0) AS compliant_installations,
      COALESCE(i.nc_inst, 0)        AS nc_installations,
      COALESCE(i.compliant_sites, 0) AS compliant_sites,
      COALESCE(i.nc_sites, 0)       AS nc_site_count,
      COALESCE(ra.compliant_rma, 0) AS compliant_rma,
      COALESCE(ra.nc_rma, 0)        AS nc_rma
    FROM all_periods p
    LEFT JOIN inst i ON p.half_year = i.half_year
    LEFT JOIN rma_agg ra ON p.half_year = ra.half_year
    ORDER BY p.half_year
  `.trim()
}

/** Compliance summary KPIs — counts of violations per category */
export const COMPLIANCE_SUMMARY = (where: string) => `
  SELECT
    (SELECT COUNT(DISTINCT site_id) FROM fleet
     WHERE tss_region = 'NA' AND LOWER(circuit_phase) = 'singlephase'
       AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
       AND ${where}) AS cat1_sites,
    (SELECT SUM(unit_count) FROM fleet
     WHERE tss_region = 'NA' AND LOWER(circuit_phase) = 'singlephase'
       AND model_name IN (${sqlModelList(CIRCUIT_PHASE_SINGLE_RESTRICTED)})
       AND ${where}) AS cat1_units,
    (SELECT COUNT(DISTINCT site_id) FROM fleet
     WHERE tss_region = 'NA'
       AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
       AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
       AND ${where}) AS cat2_sites,
    (SELECT SUM(unit_count) FROM fleet
     WHERE tss_region = 'NA'
       AND (LOWER(production_eim_config) LIKE 'three%' OR LOWER(consumption_eim_config) LIKE 'three%')
       AND model_name IN (${sqlModelList(THREE_PHASE_RESTRICTED)})
       AND ${where}) AS cat2_units
`
