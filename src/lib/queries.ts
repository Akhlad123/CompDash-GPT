export const QUERY_SITE_SUMMARY = `
  SELECT
    site_id,
    COUNT(DISTINCT serial_number) AS inverter_count,
    SUM(energy_produced)          AS total_energy,
    AVG(dc_current * dc_voltage)  AS avg_dc_power,
    AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temperature,
    CAST(MIN(timestamp) AS VARCHAR) AS first_timestamp,
    CAST(MAX(timestamp) AS VARCHAR) AS last_timestamp,
    COUNT(*)                      AS row_count
  FROM telemetry
  WHERE 1=1 {date_filter}
  GROUP BY site_id
  ORDER BY site_id
`

export const QUERY_DAILY_SITE_ENERGY = `
  SELECT
    site_id,
    CAST(COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE)) AS VARCHAR) AS date,
    SUM(energy_produced)    AS daily_energy
  FROM telemetry
  WHERE 1=1 {date_filter}
  GROUP BY site_id, COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE))
  ORDER BY site_id, date
`

export const QUERY_INVERTER_SUMMARY = `
  SELECT
    serial_number,
    site_id,
    sku_name,
    SUM(energy_produced)          AS total_energy,
    AVG(dc_current * dc_voltage)  AS avg_dc_power,
    AVG((temperature_f - 32) * 5.0 / 9.0) AS avg_temperature,
    CAST(MIN(timestamp) AS VARCHAR) AS first_timestamp,
    CAST(MAX(timestamp) AS VARCHAR) AS last_timestamp,
    COUNT(*)                      AS row_count
  FROM telemetry
  WHERE 1=1 {site_filter} {date_filter}
  GROUP BY serial_number, site_id, sku_name
  ORDER BY serial_number
`

export const QUERY_TIMESERIES = `
  SELECT
    CAST({bucket_expr} AS VARCHAR) AS bucket,
    site_id,
    serial_number,
    AVG({metric_expr})              AS metric_value,
    COUNT(*)                        AS sample_count
  FROM telemetry
  WHERE 1=1
    {site_filter}
    {inverter_filter}
    {date_filter}
  GROUP BY {bucket_expr}, site_id, serial_number
  ORDER BY {bucket_expr}, site_id, serial_number
`

export const QUERY_ANOMALY_ZSCORE = `
  SELECT
    serial_number,
    site_id,
    CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date,
    SUM(energy_produced)    AS daily_energy,
    AVG(SUM(energy_produced)) OVER (PARTITION BY site_id)  AS site_avg_energy,
    STDDEV(SUM(energy_produced)) OVER (PARTITION BY site_id) AS site_std_energy,
    CASE
      WHEN STDDEV(SUM(energy_produced)) OVER (PARTITION BY site_id) > 0
      THEN (SUM(energy_produced) - AVG(SUM(energy_produced)) OVER (PARTITION BY site_id))
           / STDDEV(SUM(energy_produced)) OVER (PARTITION BY site_id)
      ELSE 0
    END AS z_score
  FROM telemetry
  GROUP BY serial_number, site_id, CAST(timestamp AS DATE)
  ORDER BY ABS(z_score) DESC
`

export const QUERY_HEATMAP = `
  SELECT
    serial_number,
    CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date,
    SUM(energy_produced)    AS daily_energy
  FROM telemetry
  WHERE site_id = '{site_id}'
  GROUP BY serial_number, CAST(timestamp AS DATE)
  ORDER BY serial_number, date
`

export const QUERY_ANOMALY_INVERTER_TOTALS = `
  SELECT
    t.serial_number,
    t.site_id,
    t.sku_name,
    SUM(t.energy_produced)  AS total_energy,
    s.site_mean,
    s.site_std,
    CASE
      WHEN s.site_std > 0
      THEN (SUM(t.energy_produced) - s.site_mean) / s.site_std
      ELSE 0
    END AS z_score
  FROM telemetry t
  INNER JOIN (
    SELECT
      site_id,
      AVG(inv_energy) AS site_mean,
      COALESCE(STDDEV_POP(inv_energy), 0) AS site_std
    FROM (
      SELECT site_id, serial_number, SUM(energy_produced) AS inv_energy
      FROM telemetry
      WHERE 1=1 {site_filter}
      GROUP BY site_id, serial_number
    ) sub
    GROUP BY site_id
  ) s ON t.site_id = s.site_id
  WHERE 1=1 {site_filter_outer}
  GROUP BY t.serial_number, t.site_id, t.sku_name, s.site_mean, s.site_std
  ORDER BY z_score ASC
`

export const QUERY_HEATMAP_MULTI = `
  SELECT
    serial_number,
    site_id,
    sku_name,
    CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date,
    SUM(energy_produced)    AS daily_energy
  FROM telemetry
  WHERE 1=1 {site_filter}
  GROUP BY serial_number, site_id, sku_name, CAST(timestamp AS DATE)
  ORDER BY serial_number, date
`

export const QUERY_KPI_TOTALS = `
  SELECT
    COUNT(DISTINCT site_id)         AS total_sites,
    COUNT(DISTINCT serial_number)   AS total_inverters,
    SUM(energy_produced)            AS total_energy,
    CAST(MIN(timestamp) AS VARCHAR) AS date_from,
    CAST(MAX(timestamp) AS VARCHAR) AS date_to
  FROM telemetry
  WHERE 1=1 {date_filter}
`

// ── Helpers ──────────────────────────────────────────────────────────────

export type MetricKey =
  | 'dc_power'
  | 'ac_power'
  | 'energy_produced'
  | 'temperature_c'
  | 'ac_voltage'
  | 'ac_frequency'
  | 'dc_current'
  | 'dc_voltage'

export type Granularity = 'raw' | 'hourly' | 'daily' | 'monthly'

const METRIC_EXPR: Record<MetricKey, string> = {
  dc_power: 'dc_current * dc_voltage',
  ac_power: 'CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END',
  energy_produced: 'energy_produced',
  temperature_c: '(temperature_f - 32) * 5.0 / 9.0',
  ac_voltage: 'ac_voltage',
  ac_frequency: 'ac_frequency',
  dc_current: 'dc_current',
  dc_voltage: 'dc_voltage',
}

const BUCKET_EXPR: Record<Granularity, string> = {
  raw: 'timestamp',
  hourly: "DATE_TRUNC('hour', timestamp)",
  daily: 'CAST(timestamp AS DATE)',
  monthly: "DATE_TRUNC('month', timestamp)",
}

function padDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function buildDateFilter(dateRange: { from: Date; to: Date } | null): string {
  if (!dateRange) return ''
  const from = padDate(dateRange.from)
  const to = padDate(dateRange.to)
  return `AND COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE)) >= '${from}' AND COALESCE(TRY_CAST(local_date AS DATE), CAST(timestamp AS DATE)) <= '${to}'`
}

export function buildTimeseriesQuery(
  metric: MetricKey,
  granularity: Granularity,
  siteIds: string[],
  inverterIds: string[],
  dateRange: { from: Date; to: Date } | null = null
): string {
  const metricExpr = METRIC_EXPR[metric]
  const bucketExpr = BUCKET_EXPR[granularity]

  const siteFilter =
    siteIds.length > 0
      ? `AND site_id IN (${siteIds.map((s) => `'${s}'`).join(', ')})`
      : ''

  const inverterFilter =
    inverterIds.length > 0
      ? `AND serial_number IN (${inverterIds.map((s) => `'${s}'`).join(', ')})`
      : ''

  return QUERY_TIMESERIES
    .replaceAll('{bucket_expr}', bucketExpr)
    .replace('{metric_expr}', metricExpr)
    .replace('{site_filter}', siteFilter)
    .replace('{inverter_filter}', inverterFilter)
    .replace('{date_filter}', buildDateFilter(dateRange))
}

export function buildInverterSummaryQuery(siteId: string, dateRange: { from: Date; to: Date } | null = null): string {
  const siteFilter = siteId && siteId !== '__all__'
    ? `AND site_id = '${siteId}'`
    : ''
  return QUERY_INVERTER_SUMMARY
    .replace('{site_filter}', siteFilter)
    .replace('{date_filter}', buildDateFilter(dateRange))
}

export function buildSiteSummaryQuery(dateRange: { from: Date; to: Date } | null = null): string {
  return QUERY_SITE_SUMMARY.replace('{date_filter}', buildDateFilter(dateRange))
}

export function buildDailyEnergyQuery(dateRange: { from: Date; to: Date } | null = null): string {
  return QUERY_DAILY_SITE_ENERGY.replace('{date_filter}', buildDateFilter(dateRange))
}

export function buildKPIQuery(dateRange: { from: Date; to: Date } | null = null): string {
  return QUERY_KPI_TOTALS.replace('{date_filter}', buildDateFilter(dateRange))
}

export function buildHeatmapQuery(siteId: string): string {
  return QUERY_HEATMAP.replace('{site_id}', siteId)
}

export function buildAnomalyQuery(siteIds: string[]): string {
  const siteFilter =
    siteIds.length > 0
      ? `AND site_id IN (${siteIds.map((s) => `'${s}'`).join(', ')})`
      : ''
  const siteFilterOuter =
    siteIds.length > 0
      ? `AND t.site_id IN (${siteIds.map((s) => `'${s}'`).join(', ')})`
      : ''
  return QUERY_ANOMALY_INVERTER_TOTALS
    .replace('{site_filter_outer}', siteFilterOuter)
    .replace(/{site_filter}/g, siteFilter)
}

export function buildHeatmapMultiQuery(siteIds: string[]): string {
  const siteFilter =
    siteIds.length > 0
      ? `AND site_id IN (${siteIds.map((s) => `'${s}'`).join(', ')})`
      : ''
  return QUERY_HEATMAP_MULTI.replace('{site_filter}', siteFilter)
}

/**
 * Hourly-aggregated AC power / DC current / DC voltage per inverter — the
 * base series for Clipping Analysis. AC power is derived the same way as
 * METRIC_EXPR.ac_power (energy_produced over duration); DC current/voltage
 * are simple hourly averages. Grouped by calendar date too so clipping runs
 * never spill across midnight.
 */
export const QUERY_CLIPPING_HOURLY = `
  SELECT
    site_id,
    serial_number,
    sku_name,
    CAST(DATE_TRUNC('hour', timestamp) AS VARCHAR) AS hour,
    CAST(CAST(timestamp AS DATE) AS VARCHAR)        AS date,
    AVG(CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END) AS ac_power,
    AVG(dc_current) AS dc_current,
    AVG(dc_voltage) AS dc_voltage,
    AVG(temperature_f)  AS avg_temperature_f,
    MAX(temperature_f)  AS max_temperature_f,
    COUNT(*) AS sample_count
  FROM telemetry
  WHERE 1=1 {site_filter} {date_filter}
  GROUP BY site_id, serial_number, sku_name, DATE_TRUNC('hour', timestamp), CAST(timestamp AS DATE)
  ORDER BY serial_number, hour
`

export function buildClippingHourlyQuery(
  siteIds: string[],
  dateRange: { from: Date; to: Date } | null = null
): string {
  const siteFilter =
    siteIds.length > 0
      ? `AND site_id IN (${siteIds.map((s) => `'${s}'`).join(', ')})`
      : ''
  return QUERY_CLIPPING_HOURLY
    .replace('{site_filter}', siteFilter)
    .replace('{date_filter}', buildDateFilter(dateRange))
}
