// Ported from:
// "Fleet data analytics/Q1 and Q2-26/Fleet data Q1 and Q2-26 analytics.py"
// Keep in sync if the Python script's REGION_BUNDLES / REGION_POWER_BINS /
// WAFER_ORDER / WAFER_COLORS / ALLOWED_MICROS are ever updated.

export interface RegionBundle {
  name: string
  countries: Set<string>
}

export const REGION_BUNDLES: RegionBundle[] = [
  { name: 'North America', countries: new Set(['United States', 'Puerto Rico', 'Canada']) },
  { name: 'France and Spain', countries: new Set(['France', 'Spain']) },
  { name: 'Germany', countries: new Set(['Germany']) },
  { name: 'Netherlands and UK', countries: new Set(['Netherlands', 'United Kingdom']) },
  { name: 'Australia and New Zealand', countries: new Set(['Australia', 'New Zealand']) },
  {
    name: 'Emerging Market (India, Brazil, Thailand)',
    countries: new Set(['India', 'Brazil', 'Thailand']),
  },
]

export const REGION_CODES: string[] = REGION_BUNDLES.map((r) => r.name)

export const REGION_DISPLAY: Record<string, string> = REGION_CODES.reduce(
  (acc, name) => {
    acc[name] = name
    return acc
  },
  {} as Record<string, string>
)

/** Assigns a fleet row's Region based on its Country. Mirrors assign_region() in the Python script. */
export function assignRegion(country: string | null | undefined): string | null {
  if (!country) return null
  for (const bundle of REGION_BUNDLES) {
    if (bundle.countries.has(country)) return bundle.name
  }
  return null
}

export interface PowerBinDef {
  /** Ascending bin edges, same semantics as pandas.cut bins (right=False i.e. [lo, hi)) */
  bins: number[]
  labels: string[]
}

export const REGION_POWER_BINS: Record<string, PowerBinDef> = {
  'North America': {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  'France and Spain': {
    bins: [0, 401, 426, 476, 501, 99999],
    labels: ['<=400 W', '401-425 W', '426-475 W', '476-500 W', '>500 W'],
  },
  Germany: {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  'Netherlands and UK': {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  'Australia and New Zealand': {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  'Emerging Market (India, Brazil, Thailand)': {
    bins: [0, 501, 551, 601, 651, 99999],
    labels: ['<=500 W', '501-550 W', '551-600 W', '601-650 W', '>650 W'],
  },
}

/**
 * Assigns a Power Block label for a given region + module STC power (W).
 * Mirrors assign_power_block() (pandas.cut with right=False → bin is [lo, hi)).
 * Returns null if region has no bin definition or power is null/undefined.
 */
export function assignPowerBlock(region: string | null, powerW: number | null | undefined): string | null {
  if (!region || powerW == null || !Number.isFinite(powerW)) return null
  const def = REGION_POWER_BINS[region]
  if (!def) return null
  const { bins, labels } = def
  for (let i = 0; i < labels.length; i++) {
    const lo = bins[i]
    const hi = bins[i + 1]
    if (powerW >= lo && powerW < hi) return labels[i]
  }
  return null
}

export const WAFER_ORDER = ['M6', 'M10', 'G12R', 'G12'] as const
export type WaferType = (typeof WAFER_ORDER)[number]

export const WAFER_ALL = ['M6', 'M10', 'G12R', 'G12', 'No data'] as const

export const WAFER_COLORS: Record<WaferType, string> = {
  M6: '#2563EB',
  M10: '#059669',
  G12R: '#C026D3',
  G12: '#D97706',
}

/** Microinverter Product Types eligible for Fleet analytics — mirrors ALLOWED_MICROS. */
export const ALLOWED_MICROS: Set<string> = new Set([
  'IQ7A', 'IQ8P', 'IQ8HC', 'IQ8MC', 'IQ8PLUS', 'IQ8AC', 'IQ7+', 'IQ7',
  'IQ7X', 'IQ8', 'IQ8M', 'IQ8X', 'IQ8P-3P', 'IQ9N-3P-277', 'IQ7HS',
  'IQ7AM', 'IQ7XS', 'IQ9N', 'IQ7PD', 'IQ8H', 'IQ7AS', 'IQ8H-3P', 'IQ8D',
])

/** Background colors for power-bin columns in region charts, cycled by bin position. */
export const BIN_POSITION_COLORS: string[] = [
  '#DBEAFE', '#b4e0c9', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#FEE2E2',
]

/**
 * A fleet row has usable module data if it has a positive STC rating AND a
 * known wafer value. Mirrors _has_module_data() in the Python script.
 */
export function hasModuleData(stcRatingW: number | null | undefined, moduleWafer: string | null | undefined): boolean {
  const validPower = stcRatingW != null && Number.isFinite(stcRatingW) && stcRatingW > 0
  const validWafer = !!moduleWafer && !['No data', 'No check', ''].includes(moduleWafer)
  return validPower && validWafer
}

/**
 * Builds a SQL CASE expression that buckets `column` into the given bins/labels
 * (right-open intervals [lo, hi), matching pandas.cut(right=False) semantics —
 * same as assignPowerBlock()). Lets the UI recompute power buckets on the fly
 * from raw stc_rating2 with user-edited ranges, without regenerating the parquet.
 */
export function buildPowerBucketCaseSql(def: PowerBinDef, column: string = 'stc_rating2'): string {
  const { bins, labels } = def
  const cases = labels
    .map((label, i) => `WHEN ${column} >= ${bins[i]} AND ${column} < ${bins[i + 1]} THEN '${label.replace(/'/g, "''")}'`)
    .join(' ')
  return `CASE ${cases} ELSE NULL END`
}

/**
 * Canonical ordered list of TSS region codes as they appear in the Excel
 * data ("TSS region" column). Used as the single source of truth for the
 * Region multi-select on every Fleet page.
 */
export const TSS_REGION_ORDER = ['NA', 'EURO', 'BR', 'ANZP', 'LATAM', 'IN', 'EMKT'] as const

/**
 * Friendly display names for the raw "TSS region" Excel codes (tss_region
 * column — passed through as-is from source data, see prepare_fleet_data.py).
 * Filtering/grouping always uses the raw code; only the label shown to the
 * user is translated via this map.
 */
export const TSS_REGION_DISPLAY: Record<string, string> = {
  NA: 'North America (NA)',
  EURO: 'Europe (EURO)',
  BR: 'Brazil (BR)',
  ANZP: 'Australia and New Zealand (ANZP)',
  LATAM: 'Latin America (LATAM)',
  IN: 'India (IN)',
  EMKT: 'Emerging Market (EMKT)',
}

export function tssRegionLabel(code: string): string {
  return TSS_REGION_DISPLAY[code] ?? code
}

/**
 * Power bin definitions keyed by TSS region code. Used on the Summary Chart
 * and Wafer Detail pages for tss_region-based breakdowns. Regions that share
 * the same country-level split (e.g. EURO covers France/Spain, Germany,
 * Netherlands/UK) get a single common bin definition here.
 */
export const TSS_REGION_POWER_BINS: Record<string, PowerBinDef> = {
  NA: {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  EURO: {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  BR: {
    bins: [0, 501, 551, 601, 651, 99999],
    labels: ['<=500 W', '501-550 W', '551-600 W', '601-650 W', '>650 W'],
  },
  ANZP: {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  LATAM: {
    bins: [0, 401, 426, 451, 476, 99999],
    labels: ['<=400 W', '401-425 W', '426-450 W', '451-475 W', '>475 W'],
  },
  IN: {
    bins: [0, 501, 551, 601, 651, 99999],
    labels: ['<=500 W', '501-550 W', '551-600 W', '601-650 W', '>650 W'],
  },
  EMKT: {
    bins: [0, 501, 551, 601, 651, 99999],
    labels: ['<=500 W', '501-550 W', '551-600 W', '601-650 W', '>650 W'],
  },
}

/** Default global power bucket definition mirroring the raw "Power Bucket" Excel field. */
export const DEFAULT_PRODUCT_POWER_BINS: PowerBinDef = {
  bins: [0, 300, 351, 401, 426, 451, 476, 501, 551, 601, 651, 701, 99999],
  labels: [
    '<300', '300-350', '351-400', '401-425', '426-450', '451-475',
    '476-500', '501-550', '551-600', '601-650', '651-700', '>701',
  ],
}
