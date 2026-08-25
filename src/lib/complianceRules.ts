// ─── Compliance Rules Registry ────────────────────────────────────────────────
//
// Single source of truth for microinverter compatibility checks. Update these
// arrays/maps when new products launch or restrictions change — the Compliance
// page, SQL queries, and NLP layer all derive from this file.

// ────────────────────────────────────────────────────────────────────────────────
// Category 1 — Circuit Phase restriction (NA only)
// These Model Names (column AS in source Excel) are NOT allowed on
// "SinglePhase" circuit phase systems.
// ────────────────────────────────────────────────────────────────────────────────
export const CIRCUIT_PHASE_SINGLE_RESTRICTED: readonly string[] = [
  'IQ8-60-2-US',
  'IQ8-60-M-US',
  'IQ8PLUS-72-2-US',
  'IQ8PLUS-72-M-US',
  'IQ8M-72-2-US',
  'IQ8M-72-M-US',
  'IQ8A-72-2-US',
  'IQ8A-72-M-US',
  'IQ8H-240-72-2-US',
  'IQ8H-240-72-M-US',
] as const

// ────────────────────────────────────────────────────────────────────────────────
// Category 2 — Three-Phase EIM restriction (NA only)
// Same Model Names are NOT allowed when either Production EIM Config or
// Consumption EIM Config starts with "Three" (case-insensitive).
// ────────────────────────────────────────────────────────────────────────────────
export const THREE_PHASE_RESTRICTED: readonly string[] = CIRCUIT_PHASE_SINGLE_RESTRICTED

// ────────────────────────────────────────────────────────────────────────────────
// Category 3 — Module electrical compatibility (all regions)
// Maps product_type → { maxVoc (V), maxIsc (A) }.
// If the module's Voc@-40°C or Isc@60°C exceeds these limits, the pairing
// is flagged as non-compatible.
// ────────────────────────────────────────────────────────────────────────────────
export interface InverterLimit {
  maxVoc: number  // volts
  maxIsc: number  // amps
}

export const INVERTER_LIMITS: Readonly<Record<string, InverterLimit>> = {
  'IQ8':       { maxVoc: 48, maxIsc: 15 },
  'IQ8PLUS':   { maxVoc: 60, maxIsc: 20 },
  'IQ8M':      { maxVoc: 60, maxIsc: 20 },
  'IQ8A':      { maxVoc: 60, maxIsc: 20 },
  'IQ8H':      { maxVoc: 60, maxIsc: 20 },
  'IQ8MC':     { maxVoc: 60, maxIsc: 20 },
  'IQ8AC':     { maxVoc: 60, maxIsc: 20 },
  'IQ8HC':     { maxVoc: 60, maxIsc: 20 },
  'IQ8X':      { maxVoc: 80, maxIsc: 13 },
  'IQ7':       { maxVoc: 50, maxIsc: 15 },
  'IQ7PLUS':   { maxVoc: 60, maxIsc: 20 },
  'IQ7A':      { maxVoc: 60, maxIsc: 20 },
  'IQ7X':      { maxVoc: 80, maxIsc: 13 },
  'IQ7AM':     { maxVoc: 60, maxIsc: 20 },
  'IQ7AS':     { maxVoc: 60, maxIsc: 20 },
  'IQ7HS':     { maxVoc: 60, maxIsc: 20 },
  'IQ7XS':     { maxVoc: 80, maxIsc: 13 },
  'IQ8P':      { maxVoc: 65, maxIsc: 20 },
  'IQ8P-3P':   { maxVoc: 65, maxIsc: 20 },
  'IQ8H-3P':   { maxVoc: 60, maxIsc: 20 },
  'IQ9N':      { maxVoc: 60, maxIsc: 20 },
  'IQ9N-3P':   { maxVoc: 60, maxIsc: 20 },
  'IQ9S-3P':   { maxVoc: 65, maxIsc: 24 },
}

// ────────────────────────────────────────────────────────────────────────────────
// Temperature de-rating coefficients (standard PV datasheet %/°C ÷ 100)
// ────────────────────────────────────────────────────────────────────────────────
// Voc temperature coefficient: −0.25%/°C → multiply by (−0.0025)
// Isc temperature coefficient: +0.04%/°C → multiply by (+0.0004)
// STC reference temperature: 25°C

/** Voc at −40°C = Voc_STC × VOC_COLD_FACTOR (ΔT = −65°C from 25°C) */
export const VOC_COLD_FACTOR = 1 + 0.0025 * 65   // 1.1625

/** Isc at 60°C = Isc_STC × ISC_HOT_FACTOR (ΔT = +35°C from 25°C) */
export const ISC_HOT_FACTOR  = 1 + 0.0004 * 35    // 1.014

// ────────────────────────────────────────────────────────────────────────────────
// Product type aliases — maps data values to canonical INVERTER_LIMITS keys
// ────────────────────────────────────────────────────────────────────────────────
export const PRODUCT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'IQ7+':        'IQ7PLUS',
  'IQ9N-3P-277': 'IQ9N-3P',
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the inverter electrical limits for a given `product_type`.
 * Uses exact match first, then checks aliases.
 * Returns null if no matching product type is found.
 */
export function getInverterLimits(productType: string): InverterLimit | null {
  if (!productType) return null
  const trimmed = productType.trim()
  if (trimmed in INVERTER_LIMITS) return INVERTER_LIMITS[trimmed]
  const alias = PRODUCT_TYPE_ALIASES[trimmed]
  if (alias && alias in INVERTER_LIMITS) return INVERTER_LIMITS[alias]
  return null
}

/**
 * Build a SQL-safe IN-list string from an array of model names.
 * Used by compliance query builders.
 */
export function sqlModelList(models: readonly string[]): string {
  return models.map((m) => `'${m.replace(/'/g, "''")}'`).join(', ')
}

/**
 * Build a SQL VALUES table of inverter limits for use with DuckDB's
 * JOIN. Emits exact product_type rows for both canonical names and
 * aliases (e.g. both 'IQ7PLUS' and 'IQ7+' get their own row).
 */
export function sqlInverterLimitsValues(): string {
  const rows: string[] = []
  for (const [pt, lim] of Object.entries(INVERTER_LIMITS)) {
    rows.push(`('${pt}', ${lim.maxVoc}, ${lim.maxIsc})`)
  }
  for (const [alias, canonical] of Object.entries(PRODUCT_TYPE_ALIASES)) {
    const lim = INVERTER_LIMITS[canonical]
    if (lim) rows.push(`('${alias}', ${lim.maxVoc}, ${lim.maxIsc})`)
  }
  return rows.join(', ')
}
