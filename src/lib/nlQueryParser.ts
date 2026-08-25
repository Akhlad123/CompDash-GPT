// Rule-based natural-language -> SQL parser for the `fleet` table.
// Tried FIRST for every question (see nlQueryLLM.ts for the LLM fallback,
// only invoked when this parser's confidence is 'low').

import { getDistinctFleetValues } from './fleetDuckdb'
import {
  COMPLIANCE_CIRCUIT_PHASE,
  COMPLIANCE_THREE_PHASE,
  COMPLIANCE_MODULE_LIMITS,
} from './fleetQueries'

export interface EntityDictionaries {
  country: string[]
  region_bundle: string[]
  tss_region: string[]
  tss_country: string[]
  product_type: string[]
  module_wafer: string[]
  power_bucket: string[]
  quarter_first_interval: string[]
}

const ENTITY_COLUMNS: (keyof EntityDictionaries)[] = [
  'quarter_first_interval',
  'region_bundle',
  'tss_region',
  'tss_country',
  'country',
  'product_type',
  'module_wafer',
  'power_bucket',
]

let cachedDictionaries: EntityDictionaries | null = null

/** Fetches distinct values for every filterable fleet column, once per session. */
export async function loadEntityDictionaries(): Promise<EntityDictionaries> {
  if (cachedDictionaries) return cachedDictionaries
  const [country, region_bundle, tss_region, tss_country, product_type, module_wafer, power_bucket, quarter_first_interval] =
    await Promise.all([
      getDistinctFleetValues('country'),
      getDistinctFleetValues('region_bundle'),
      getDistinctFleetValues('tss_region'),
      getDistinctFleetValues('tss_country'),
      getDistinctFleetValues('product_type'),
      getDistinctFleetValues('module_wafer'),
      getDistinctFleetValues('power_bucket'),
      getDistinctFleetValues('quarter_first_interval'),
    ])
  cachedDictionaries = {
    country, region_bundle, tss_region, tss_country,
    product_type, module_wafer, power_bucket, quarter_first_interval,
  }
  return cachedDictionaries
}

interface MetricDef {
  keywords: string[]
  column: string
  label: string
}

const METRIC_DEFS: MetricDef[] = [
  { keywords: ['irradiance', 'ghi', 'solar irradiance', 'solar exposure', 'irradiation'], column: 'irr_ann_kwh_m2_month', label: 'Irradiance (kWh/m²/month)' },
  { keywords: ['stc rating', 'module power', 'power rating', 'module wattage', 'wattage'], column: 'stc_rating2', label: 'STC Rating (W)' },
  { keywords: ['unit count', 'units', 'microinverters', 'inverter count', 'number of units'], column: 'unit_count', label: 'Unit Count' },
  { keywords: ['stc mwdc', 'mwdc', 'capacity'], column: 'stc_mwdc', label: 'STC MWdc' },
  { keywords: ['mwac'], column: 'mwac', label: 'MWac' },
  { keywords: ['dc/ac', 'dc ac ratio', 'dc-ac ratio', 'dc ac', 'dc/ac ratio'], column: 'dc_ac_ratio', label: 'DC/AC Ratio' },
]

const DESC_KEYWORDS = ['highest', 'largest', 'most', 'max', 'maximum', 'greatest', 'top']
const ASC_KEYWORDS = ['lowest', 'smallest', 'least', 'min', 'minimum', 'bottom']

const DISPLAY_COLUMNS = [
  'site_id', 'city', 'state', 'country', 'region_bundle', 'tss_region', 'tss_country',
  'product_type', 'module_wafer', 'pv_module_make', 'stc_rating2', 'unit_count',
  'dc_ac_ratio', 'power_bucket', 'quarter_first_interval', 'irr_ann_kwh_m2_month',
  'circuit_phase', 'production_eim_config', 'consumption_eim_config', 'model_name',
] as const

export interface ParsedQuery {
  sql: string
  confidence: 'high' | 'medium' | 'low'
  explanation: string
  matchedEntities: Record<string, string>
  /** When set, the UI should ask a follow-up before running. */
  needsClarification?: {
    type: 'quarter'
    message: string
    options: string[]
  }
  /** When confidence is low or medium, an optional explanation to the user. */
  caveat?: string
  /** True when the LLM determined the question cannot be answered from the available schema. */
  unanswerable?: boolean
}

function escapeSqlLiteral(v: string): string {
  return v.replace(/'/g, "''")
}

// Common English words that collide with short dictionary codes (e.g. the
// preposition "in" vs. a tss_region code "IN"). Guards against false matches.
const STOPWORDS = new Set([
  'in', 'on', 'at', 'or', 'is', 'as', 'us', 'be', 'by', 'to', 'of', 'it', 'if', 'no',
])

/**
 * Escapes a value for use inside a regex, then wraps with word-boundary
 * anchors. Short codes (<=3 chars, e.g. "IN", "US", "UK") are matched
 * CASE-SENSITIVELY and rejected if they collide with a common English
 * stopword — otherwise phrases like "sites in Germany" would falsely match
 * a tss_region code "IN".
 */
function wordBoundaryRegex(value: string): RegExp | null {
  if (value.length <= 3 && STOPWORDS.has(value.toLowerCase())) return null
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = value.length <= 3 ? '' : 'i' // case-sensitive for short codes
  return new RegExp(`\\b${escaped}\\b`, flags)
}

function matchEntities(question: string, dictionaries: EntityDictionaries): {
  clauses: string[]
  matched: Record<string, string>
} {
  const clauses: string[] = []
  const matched: Record<string, string> = {}
  const consumedSpans = new Set<string>()

  for (const col of ENTITY_COLUMNS) {
    const values = dictionaries[col]
    // Try longer values first so "France and Spain" wins over "France" when both are present.
    const sorted = [...values].sort((a, b) => b.length - a.length)
    for (const value of sorted) {
      if (!value) continue
      const key = value.toLowerCase()
      if (consumedSpans.has(key)) continue
      const regex = wordBoundaryRegex(value)
      if (regex && regex.test(question)) {
        clauses.push(`${col} = '${escapeSqlLiteral(value)}'`)
        matched[col] = value
        consumedSpans.add(key)
        break
      }
    }
  }
  return { clauses, matched }
}

function detectMetric(question: string): MetricDef | null {
  const lower = question.toLowerCase()
  for (const def of METRIC_DEFS) {
    if (def.keywords.some((kw) => lower.includes(kw))) return def
  }
  return null
}

function detectDirection(question: string): { direction: 'ASC' | 'DESC'; hasDirectionKeyword: boolean } {
  const lower = question.toLowerCase()
  if (ASC_KEYWORDS.some((kw) => lower.includes(kw))) return { direction: 'ASC', hasDirectionKeyword: true }
  if (DESC_KEYWORDS.some((kw) => lower.includes(kw))) return { direction: 'DESC', hasDirectionKeyword: true }
  return { direction: 'DESC', hasDirectionKeyword: false } // default when no explicit direction keyword found
}

function detectLimit(question: string): number {
  const m = question.match(/top\s+(\d+)/i)
  if (m) return Math.min(parseInt(m[1], 10), 500)
  return 20
}

/**
 * Detect if a question is time-sensitive (needs a quarter filter) but the
 * user hasn't specified one. Returns true for questions about units,
 * counts, DC/AC ratio, capacity, etc., which change over time.
 */
function isTimeSensitiveQuery(question: string, metric: MetricDef | null, matched: Record<string, string>): boolean {
  // If user already specified a quarter, no need to ask
  if (matched['quarter_first_interval']) return false

  const lower = question.toLowerCase()
  const timeSensitiveKeywords = [
    'units', 'unit count', 'how many', 'count', 'total',
    'dc/ac', 'dc ac', 'dc-ac', 'capacity', 'mwdc', 'mwac',
    'number of', 'sites',
  ]
  if (timeSensitiveKeywords.some((kw) => lower.includes(kw))) return true
  if (metric && ['unit_count', 'dc_ac_ratio', 'stc_mwdc', 'mwac'].includes(metric.column)) return true
  return false
}

/** Detect if user is asking for a regional distribution/breakdown. */
function isDistributionQuery(question: string): boolean {
  const lower = question.toLowerCase()
  return /\b(distribution|breakdown|by region|by country|per region|per country|group by|grouped)\b/.test(lower)
}

// ─── Compliance keyword detection ────────────────────────────────────────────

const COMPLIANCE_KEYWORDS_GENERAL = [
  'incompatible', 'non-compatible', 'not compatible', 'not allowed',
  'compliance', 'non compatible', 'violation', 'restricted',
]

const COMPLIANCE_KEYWORDS_CAT1 = [
  'circuit phase', 'single phase violation', 'singlephase', 'single-phase',
]

const COMPLIANCE_KEYWORDS_CAT2 = [
  'three phase violation', 'three-phase', 'eim phase', 'phase compatibility',
  'three phase restriction', '3-phase', '3 phase',
]

const COMPLIANCE_KEYWORDS_CAT3 = [
  'module limit', 'voc limit', 'isc limit', 'module compatibility',
  'voc exceed', 'isc exceed', 'electrical compatibility', 'voltage limit',
  'current limit', 'voc at', 'isc at',
]

function detectComplianceQuery(lower: string): ParsedQuery | null {
  const isGeneral = COMPLIANCE_KEYWORDS_GENERAL.some((kw) => lower.includes(kw))
  const isCat1 = COMPLIANCE_KEYWORDS_CAT1.some((kw) => lower.includes(kw))
  const isCat2 = COMPLIANCE_KEYWORDS_CAT2.some((kw) => lower.includes(kw))
  const isCat3 = COMPLIANCE_KEYWORDS_CAT3.some((kw) => lower.includes(kw))

  if (!isGeneral && !isCat1 && !isCat2 && !isCat3) return null

  const where = '1=1'

  if (isCat1 && !isCat2 && !isCat3) {
    return {
      sql: COMPLIANCE_CIRCUIT_PHASE(where),
      confidence: 'high',
      explanation: 'Showing systems with Circuit Phase compliance violations (NA region, restricted models on SinglePhase).',
      matchedEntities: { compliance: 'circuit_phase' },
    }
  }

  if (isCat2 && !isCat1 && !isCat3) {
    return {
      sql: COMPLIANCE_THREE_PHASE(where),
      confidence: 'high',
      explanation: 'Showing systems with Three-Phase EIM compliance violations (NA region, restricted models on three-phase EIM).',
      matchedEntities: { compliance: 'three_phase' },
    }
  }

  if (isCat3 && !isCat1 && !isCat2) {
    return {
      sql: COMPLIANCE_MODULE_LIMITS(where),
      confidence: 'high',
      explanation: 'Showing systems where module Voc@-40°C or Isc@60°C exceeds microinverter limits.',
      matchedEntities: { compliance: 'module_limits' },
    }
  }

  // Generic compliance question — show circuit phase violations as default (most common)
  return {
    sql: COMPLIANCE_CIRCUIT_PHASE(where),
    confidence: 'high',
    explanation: 'Showing compliance violations. Tip: ask specifically about "circuit phase", "three phase", or "module limits" for targeted results.',
    matchedEntities: { compliance: 'all' },
  }
}

/**
 * Attempts to parse a natural-language fleet question into SQL using
 * dictionary-based entity extraction + keyword rules. Returns confidence
 * 'low' when no entities and no recognizable metric/aggregate were found —
 * callers should fall back to the LLM in that case.
 */
export function parseFleetQuestion(question: string, dictionaries: EntityDictionaries): ParsedQuery {
  const lower = question.toLowerCase()

  // ─── Compliance shortcut: detect compliance/incompatibility questions ────
  const complianceResult = detectComplianceQuery(lower)
  if (complianceResult) return complianceResult

  const { clauses, matched } = matchEntities(question, dictionaries)
  const metric = detectMetric(question)
  const limit = detectLimit(question)
  const { direction, hasDirectionKeyword } = detectDirection(question)

  const whereClause = clauses.length > 0 ? clauses.join(' AND ') : '1=1'

  // Aggregate-style question: "how many sites...", "total units...", "average stc rating..."
  const isCount = /\bhow many\b|\bcount\b/.test(lower)
  const isTotal = /\btotal\b|\bsum of\b/.test(lower)
  const isAverage = /\baverage\b|\bavg\b|\bmean\b/.test(lower)
  const isDistrib = isDistributionQuery(question)

  // Check if this is time-sensitive and needs clarification
  const needsTime = isTimeSensitiveQuery(question, metric, matched)
  const availableQuarters = dictionaries.quarter_first_interval.filter(Boolean).sort()

  // Build clarification object when needed
  const clarification = needsTime && availableQuarters.length > 0
    ? {
        type: 'quarter' as const,
        message: `This query is time-sensitive. Data is available for: ${availableQuarters.join(', ')}. Which period would you like to query? You can select one or type "all" for all periods.`,
        options: [...availableQuarters, 'All periods'],
      }
    : undefined

  // DC/AC ratio distribution by region/country
  if (isDistrib && metric) {
    const groupCol = matched['tss_region'] ? 'tss_region'
      : matched['country'] ? 'country'
      : matched['region_bundle'] ? 'region_bundle'
      : 'tss_region'
    return {
      sql: `SELECT ${groupCol}, COUNT(DISTINCT site_id) AS sites, ROUND(AVG(${metric.column}), 3) AS avg_${metric.column}, ROUND(MIN(${metric.column}), 3) AS min_${metric.column}, ROUND(MAX(${metric.column}), 3) AS max_${metric.column} FROM fleet WHERE ${whereClause} AND ${metric.column} IS NOT NULL GROUP BY ${groupCol} ORDER BY avg_${metric.column} ${direction}`,
      confidence: 'high',
      explanation: `${metric.label} distribution grouped by ${prettyEntityCol(groupCol)}, filtered by: ${Object.values(matched).join(', ') || 'all data'}`,
      matchedEntities: matched,
      needsClarification: clarification,
    }
  }

  if (isCount) {
    return {
      sql: `SELECT COUNT(DISTINCT site_id) AS site_count, SUM(unit_count) AS total_units FROM fleet WHERE ${whereClause}`,
      confidence: clauses.length > 0 ? 'high' : 'medium',
      explanation: `Counting distinct sites and total units matching: ${Object.values(matched).join(', ') || 'no filters'}`,
      matchedEntities: matched,
      needsClarification: clarification,
      caveat: clauses.length === 0 ? 'No specific region/country filter detected — showing results across all data. Try adding a region like "in North America" or "in Europe".' : undefined,
    }
  }

  if ((isTotal || isAverage) && metric) {
    const agg = isAverage ? 'AVG' : 'SUM'
    return {
      sql: `SELECT ${agg}(${metric.column}) AS result FROM fleet WHERE ${whereClause} AND ${metric.column} IS NOT NULL`,
      confidence: 'high',
      explanation: `${agg === 'AVG' ? 'Average' : 'Total'} ${metric.label} matching: ${Object.values(matched).join(', ') || 'no filters'}`,
      matchedEntities: matched,
      needsClarification: clarification,
    }
  }

  // DC/AC ratio query — if they just ask "DC AC ratio of North America" without avg/total,
  // default to showing the average + distribution summary
  if (metric?.column === 'dc_ac_ratio' && !isTotal && !isAverage && !hasDirectionKeyword) {
    const filterDesc = Object.values(matched).join(', ') || 'all data'
    return {
      sql: `SELECT COUNT(DISTINCT site_id) AS sites, ROUND(AVG(dc_ac_ratio), 3) AS avg_dc_ac_ratio, ROUND(MIN(dc_ac_ratio), 3) AS min_dc_ac_ratio, ROUND(MAX(dc_ac_ratio), 3) AS max_dc_ac_ratio, ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dc_ac_ratio), 3) AS median_dc_ac_ratio FROM fleet WHERE ${whereClause} AND dc_ac_ratio IS NOT NULL`,
      confidence: clauses.length > 0 ? 'high' : 'medium',
      explanation: `DC/AC ratio summary for: ${filterDesc}`,
      matchedEntities: matched,
      needsClarification: clarification,
      caveat: clauses.length === 0 ? 'No region filter detected. Try "DC/AC ratio of North America" or "DC/AC ratio in Europe".' : undefined,
    }
  }

  // Default: ranked listing query (e.g. "top 10 sites with highest irradiance in France...")
  const orderCol = metric?.column ?? 'unit_count'
  const sql = `
    SELECT ${DISPLAY_COLUMNS.join(', ')}
    FROM fleet
    WHERE ${whereClause} AND ${orderCol} IS NOT NULL
    ORDER BY ${orderCol} ${direction}
    LIMIT ${limit}
  `.trim()

  const hasSignal = clauses.length > 0 || metric !== null || hasDirectionKeyword
  return {
    sql,
    confidence: hasSignal ? (clauses.length > 0 && metric !== null ? 'high' : 'medium') : 'low',
    explanation: `Top ${limit} sites ordered by ${metric?.label ?? 'Unit Count'} (${direction}), filtered by: ${Object.values(matched).join(', ') || 'no filters'}`,
    matchedEntities: matched,
    needsClarification: clarification,
    caveat: !hasSignal ? 'I couldn\'t identify a clear metric or filter in your question. Try asking about units, DC/AC ratio, irradiance, or STC rating with a region/country.' : undefined,
  }
}

function prettyEntityCol(col: string): string {
  const map: Record<string, string> = {
    tss_region: 'TSS Region',
    tss_country: 'TSS Country',
    country: 'Country',
    region_bundle: 'Region',
    product_type: 'Product Type',
    module_wafer: 'Module Wafer',
    power_bucket: 'Power Bucket',
    quarter_first_interval: 'Quarter',
  }
  return map[col] ?? col
}
