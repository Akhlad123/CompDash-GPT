// Peer site discovery v2 — continuous 10-point similarity scoring.
// All calculations are deterministic (no LLM involvement).
// Architecture: Fleet only → score → top-5 → then Telemetry checked separately.
//
// Score breakdown (max 10.0):
//   Geography      3.0  — Haversine + power-law decay, hard cutoff 300 km
//   Module Power   2.0  — exponential decay on % difference
//   Microinverter  2.5  — 5-tier hierarchy (exact/family/generation/class/different)
//   Wafer Size     2.0  — mm-dimension exponential decay
//   Irradiance     0.5  — exponential decay on % difference
//
// Missing fields → excluded from numerator AND denominator (score normalised, coverage reported).

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FleetRow {
  site_id: string
  latitude: number | null
  longitude: number | null
  pv_module_model: string | null
  stc_rating2: number | null       // module power in watts (STC)
  module_wafer: string | null      // wafer label e.g. "M10", "G12R"
  product_type: string | null      // microinverter product type string
  model_name: string | null        // microinverter model name (primary for scoring)
  unit_count: number | null
  dc_ac_ratio: number | null
  country: string | null
  tss_region: string | null
  city: string | null
  state: string | null
  quarter_first_interval: string | null
  pv_module_make: string | null
  irr_ann_kwh_m2_month: number | null  // annual average irradiance kWh/m²/month
}

/** Score breakdown per component (null = data was missing for this field). */
export interface ScoreBreakdown {
  geography: number | null
  module_power: number | null
  microinverter: number | null
  wafer: number | null
  irradiance: number | null
}

/** Full result for a peer site from v2 scoring. */
export interface PeerSiteV2 {
  site_id: string
  distance_km: number
  total_score: number        // 0–10, normalized for missing data
  coverage: number           // 0–100 (% of max weight that had data)
  scores: ScoreBreakdown
  location: string
  // Display-only fields (not used in scoring)
  product_type: string | null
  model_name: string | null
  pv_module_model: string | null
  pv_module_make: string | null
  stc_rating2: number | null
  module_wafer: string | null
  irr_ann_kwh_m2_month: number | null
  unit_count: number | null
  quarter_first_interval: string | null
  has_module_info: boolean        // true when pv_module_model is populated
}

// ─── Configuration (all scoring params in one place — never scattered) ────────

export interface SimilarityConfig {
  weights: {
    geography: number
    modulePower: number
    microinverter: number
    wafer: number
    irradiance: number
  }
  geography: { maxDistanceKm: number; exponent: number }
  modulePower: { decayConstant: number }
  wafer: { decayConstantMm: number }
  irradiance: { decayConstant: number }
  minimumCoverage: number   // 0–1 fraction; candidates below this are excluded
  topN: number
  minWithModuleInfo: number  // guarantee at least N of topN results have pv_module_model set
  requireModuleInfo: boolean // when true, candidates without pv_module_model are excluded before scoring
}

export const DEFAULT_SIMILARITY_CONFIG: SimilarityConfig = {
  weights: {
    geography:    3.0,
    modulePower:  2.0,
    microinverter: 2.5,
    wafer:        2.0,
    irradiance:   0.5,
  },
  geography:   { maxDistanceKm: 300, exponent: 0.7 },
  modulePower: { decayConstant: 5.0 },
  wafer:       { decayConstantMm: 20.0 },
  irradiance:  { decayConstant: 4.0 },
  minimumCoverage: 0.60,
  topN: 5,
  minWithModuleInfo: 3,
  requireModuleInfo: true,
}

// ─── Module info guard ──────────────────────────────────────────────────────

/** Returns true when a fleet row carries meaningful module identification data. */
function hasModuleInfo(row: FleetRow): boolean {
  return typeof row.pv_module_model === 'string' && row.pv_module_model.trim().length > 0
}

// ─── Wafer label → mm dimension ──────────────────────────────────────────────

/** Maps Fleet wafer label strings to approximate cell dimensions in mm. */
const WAFER_MM: Record<string, number> = {
  M2:   156,
  M3:   158,
  M4:   161,
  M6:   166,
  M10:  182,
  G12R: 182,
  G12:  210,
  // Aliases / alternate spellings
  '156': 156,
  '166': 166,
  '182': 182,
  '210': 210,
}

function waferToMm(label: string | null | undefined): number | null {
  if (!label) return null
  const key = label.trim().toUpperCase().replace(/\s+/g, '')
  const direct = WAFER_MM[key]
  if (direct != null) return direct
  // Try stripping trailing letters (e.g. "M10S" → "M10")
  const stripped = key.replace(/[A-Z]+$/, '')
  return WAFER_MM[stripped] ?? null
}

// ─── Microinverter hierarchy ──────────────────────────────────────────────────

/** Extract generation prefix: "IQ9N-240-2-INT" → "IQ9", "IQ8HC" → "IQ8" etc. */
function microGeneration(model: string): string {
  const m = model.toUpperCase().trim()
  // Match IQ + digit(s) as the generation key
  const gen = m.match(/^(IQ\d+)/)
  return gen ? gen[1] : m.slice(0, 4)  // fallback: first 4 chars
}

/** Adjacent generation pairs (bidirectional). */
const ADJACENT_GENERATIONS = new Set([
  'IQ9|IQ8', 'IQ8|IQ9',
  'IQ8|IQ7', 'IQ7|IQ8',
  'IQ7|IQ6', 'IQ6|IQ7',
])

/**
 * Returns a 5-tier microinverter similarity score (0–2.5) or null if data missing.
 *
 * Tier | Relationship                        | Score
 * -----|-------------------------------------|------
 *  1   | Exact same model string             | 2.50
 *  2   | Same product-generation (IQ9 == IQ9)| 2.00
 *  3   | Adjacent generation (IQ9 vs IQ8)    | 1.35
 *  4   | Both are microinverters (IQ*)       | 0.65
 *  5   | Fundamentally different             | 0.00
 */
export function scoreMicroinverter(
  targetModel: string | null | undefined,
  candidateModel: string | null | undefined,
  maxScore = 2.5,
): number | null {
  if (!targetModel || !candidateModel) return null

  const t = targetModel.trim().toUpperCase()
  const c = candidateModel.trim().toUpperCase()

  // Tier 1 — exact match
  if (t === c) return maxScore

  const tGen = microGeneration(t)
  const cGen = microGeneration(c)

  // Tier 2 — same generation prefix
  if (tGen === cGen) return (maxScore / 2.5) * 2.00

  // Tier 3 — adjacent generation
  if (ADJACENT_GENERATIONS.has(`${tGen}|${cGen}`)) return (maxScore / 2.5) * 1.35

  // Tier 4 — both are microinverters (IQ family)
  if (t.startsWith('IQ') && c.startsWith('IQ')) return (maxScore / 2.5) * 0.65

  // Tier 5 — fundamentally different
  return 0
}

// ─── Haversine formula ────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6_371

/** Returns the great-circle distance in km. Never uses simple lat/lon subtraction. */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── Individual scoring functions ─────────────────────────────────────────────

/**
 * Geography: 3 × (1 - d/300)^0.7  for d < 300, else 0.
 * Hard cutoff at maxDistanceKm.
 */
export function scoreGeography(
  distKm: number,
  cfg: SimilarityConfig['geography'] = DEFAULT_SIMILARITY_CONFIG.geography,
  weight = DEFAULT_SIMILARITY_CONFIG.weights.geography,
): number {
  if (distKm >= cfg.maxDistanceKm) return 0
  return weight * Math.pow(1 - distKm / cfg.maxDistanceKm, cfg.exponent)
}

/**
 * Module power: 2 × e^(-k × |Pc - Pt| / Pt).
 * Returns null if either value is missing.
 */
export function scoreModulePower(
  targetW: number | null | undefined,
  candidateW: number | null | undefined,
  cfg: SimilarityConfig['modulePower'] = DEFAULT_SIMILARITY_CONFIG.modulePower,
  weight = DEFAULT_SIMILARITY_CONFIG.weights.modulePower,
): number | null {
  if (!targetW || !candidateW || targetW <= 0) return null
  const pctDiff = Math.abs(candidateW - targetW) / targetW
  return weight * Math.exp(-cfg.decayConstant * pctDiff)
}

/**
 * Wafer: 2 × e^(-|Wc - Wt| / decayConstantMm).
 * Converts string labels to mm first. Returns null if either label is unknown.
 */
export function scoreWafer(
  targetLabel: string | null | undefined,
  candidateLabel: string | null | undefined,
  cfg: SimilarityConfig['wafer'] = DEFAULT_SIMILARITY_CONFIG.wafer,
  weight = DEFAULT_SIMILARITY_CONFIG.weights.wafer,
): number | null {
  const tMm = waferToMm(targetLabel)
  const cMm = waferToMm(candidateLabel)
  if (tMm == null || cMm == null) return null
  return weight * Math.exp(-Math.abs(cMm - tMm) / cfg.decayConstantMm)
}

/**
 * Irradiance: 0.5 × e^(-k × |Ic - It| / It).
 * Returns null if either value is missing.
 */
export function scoreIrradiance(
  targetIrr: number | null | undefined,
  candidateIrr: number | null | undefined,
  cfg: SimilarityConfig['irradiance'] = DEFAULT_SIMILARITY_CONFIG.irradiance,
  weight = DEFAULT_SIMILARITY_CONFIG.weights.irradiance,
): number | null {
  if (!targetIrr || !candidateIrr || targetIrr <= 0) return null
  const pctDiff = Math.abs(candidateIrr - targetIrr) / targetIrr
  return weight * Math.exp(-cfg.decayConstant * pctDiff)
}

// ─── Composite similarity calculation ─────────────────────────────────────────

interface SimilarityResult {
  totalScore: number         // 0–10 normalised
  coverage: number           // 0–100 (%)
  distKm: number
  scores: ScoreBreakdown
}

/**
 * Calculates the full 10-point similarity between target and candidate.
 * Returns null when geographic hard cutoff is exceeded OR coverage < minimumCoverage.
 */
export function calculateSiteSimilarity(
  target: FleetRow,
  candidate: FleetRow,
  cfg: SimilarityConfig = DEFAULT_SIMILARITY_CONFIG,
): SimilarityResult | null {

  // ── Distance (always required — no lat/lon = skip) ────────────────────────
  if (
    target.latitude == null || target.longitude == null ||
    candidate.latitude == null || candidate.longitude == null
  ) return null

  const distKm = haversineKm(
    target.latitude, target.longitude,
    candidate.latitude, candidate.longitude,
  )

  // ── Geography — hard cutoff ───────────────────────────────────────────────
  const geoScore = scoreGeography(distKm, cfg.geography, cfg.weights.geography)
  if (distKm >= cfg.geography.maxDistanceKm) return null  // hard exclude

  // ── Other components (null = missing data) ────────────────────────────────
  const powerScore = scoreModulePower(target.stc_rating2, candidate.stc_rating2, cfg.modulePower, cfg.weights.modulePower)
  const microScore = scoreMicroinverter(target.model_name, candidate.model_name, cfg.weights.microinverter)
  const waferScore = scoreWafer(target.module_wafer, candidate.module_wafer, cfg.wafer, cfg.weights.wafer)
  const irrScore   = scoreIrradiance(target.irr_ann_kwh_m2_month, candidate.irr_ann_kwh_m2_month, cfg.irradiance, cfg.weights.irradiance)

  // ── Available weight (geography always counts if within cutoff) ───────────
  const W = cfg.weights
  let availableMax = W.geography  // geography is always available (we have lat/lon)
  let rawScore = geoScore

  if (powerScore != null) { availableMax += W.modulePower;   rawScore += powerScore }
  if (microScore != null) { availableMax += W.microinverter; rawScore += microScore }
  if (waferScore != null) { availableMax += W.wafer;         rawScore += waferScore }
  if (irrScore   != null) { availableMax += W.irradiance;    rawScore += irrScore   }

  const totalWeight = W.geography + W.modulePower + W.microinverter + W.wafer + W.irradiance  // = 10
  const coverage = (availableMax / totalWeight) * 100  // percentage

  // Exclude if insufficient data coverage
  if (coverage / 100 < cfg.minimumCoverage) return null

  // Normalise to 10-point scale
  const totalScore = (rawScore / availableMax) * 10

  return {
    totalScore: Math.round(totalScore * 100) / 100,
    coverage: Math.round(coverage),
    distKm: Math.round(distKm * 10) / 10,
    scores: {
      geography:    Math.round(geoScore * 100) / 100,
      module_power: powerScore != null ? Math.round(powerScore * 100) / 100 : null,
      microinverter: microScore != null ? Math.round(microScore * 100) / 100 : null,
      wafer:        waferScore != null ? Math.round(waferScore * 100) / 100 : null,
      irradiance:   irrScore   != null ? Math.round(irrScore   * 100) / 100 : null,
    },
  }
}

// ─── Main discovery function ──────────────────────────────────────────────────

/**
 * Finds up to `topN` comparable peer sites using the continuous 10-point algorithm.
 *
 * Stage 1 — geographic pre-filter: candidates within maxDistanceKm only.
 * Stage 2 — full similarity score for each eligible candidate.
 * Rank: totalScore DESC, coverage DESC, distKm ASC.
 *
 * Fleet data only. Never queries Telemetry.
 */
export function findSimilarSites(
  target: FleetRow,
  roster: FleetRow[],
  cfg: SimilarityConfig = DEFAULT_SIMILARITY_CONFIG,
  microinverterFilter?: string,   // optional exact/prefix filter (case-insensitive)
): PeerSiteV2[] {
  if (!target.site_id || target.latitude == null || target.longitude == null) return []

  const maxDist = cfg.geography.maxDistanceKm

  // Stage 1 — geo pre-filter (cheap bounding box first for speed, exact Haversine after)
  const latDelta = maxDist / 111  // ~1° lat ≈ 111 km
  const lonDelta = maxDist / (111 * Math.cos((target.latitude * Math.PI) / 180))

  const geoCandidates = roster.filter((r) => {
    if (r.site_id === target.site_id) return false
    if (r.latitude == null || r.longitude == null) return false
    // Module info requirement — skip candidates without pv_module_model when required
    if (cfg.requireModuleInfo && !hasModuleInfo(r)) return false
    // Bounding box pre-filter
    if (Math.abs(r.latitude - target.latitude!) > latDelta) return false
    if (Math.abs(r.longitude - target.longitude!) > lonDelta) return false
    // Optional microinverter filter
    if (microinverterFilter) {
      const mf = microinverterFilter.toUpperCase()
      const mn = (r.model_name ?? r.product_type ?? '').toUpperCase()
      if (!mn.startsWith(mf) && !mn.includes(mf)) return false
    }
    return true
  })

  // Stage 2 — full similarity scoring
  const scored: Array<SimilarityResult & { row: FleetRow }> = []
  for (const candidate of geoCandidates) {
    const result = calculateSiteSimilarity(target, candidate, cfg)
    if (result != null) scored.push({ ...result, row: candidate })
  }

  // Rank: score DESC, coverage DESC, distance ASC
  scored.sort(
    (a, b) => b.totalScore - a.totalScore || b.coverage - a.coverage || a.distKm - b.distKm
  )

  // ── Constrained selection: guarantee ≥ minWithModuleInfo results have pv_module_model ──
  const withMod = scored.filter((s) => hasModuleInfo(s.row))
  const minMod  = Math.min(cfg.minWithModuleInfo, withMod.length)

  const selected: typeof scored = []
  const selectedIds = new Set<string>()

  // Fill guaranteed module slots first (in score order)
  for (const s of withMod) {
    if (selected.length >= minMod) break
    selected.push(s)
    selectedIds.add(s.row.site_id)
  }

  // Fill remaining from full ranked list (score order, no duplicates)
  for (const s of scored) {
    if (selected.length >= cfg.topN) break
    if (!selectedIds.has(s.row.site_id)) {
      selected.push(s)
      selectedIds.add(s.row.site_id)
    }
  }

  // Re-sort the final selection by score so display order stays meaningful
  selected.sort(
    (a, b) => b.totalScore - a.totalScore || b.coverage - a.coverage || a.distKm - b.distKm
  )

  return selected.map(({ row: c, totalScore, coverage, distKm, scores }) => {
    const locationParts = [c.city, c.state, c.country].filter(Boolean)
    return {
      site_id: c.site_id,
      distance_km: distKm,
      total_score: totalScore,
      coverage,
      scores,
      location: locationParts.join(', ') || 'Unknown',
      product_type: c.product_type,
      model_name: c.model_name,
      pv_module_model: c.pv_module_model,
      pv_module_make: c.pv_module_make,
      stc_rating2: c.stc_rating2,
      has_module_info: hasModuleInfo(c),
      module_wafer: c.module_wafer,
      irr_ann_kwh_m2_month: c.irr_ann_kwh_m2_month,
      unit_count: c.unit_count,
      quarter_first_interval: c.quarter_first_interval,
    }
  })
}

// ─── Legacy shim (keeps siteAnalysisTool.ts import compatible during transition) ─

/** @deprecated Use findSimilarSites instead. Kept for backward-compatibility only. */
export function findPeerSites(
  target: FleetRow,
  roster: FleetRow[],
  limit = 5,
): PeerSiteV2[] {
  return findSimilarSites(target, roster, { ...DEFAULT_SIMILARITY_CONFIG, topN: limit })
}
