// Rule-based natural-language -> SQL parser for the `telemetry` table.
// Mirrors nlQueryParser.ts but targets uploaded inverter time-series data.
// Falls back to LLM (Ollama) when confidence is 'low'.

import { query } from './duckdb'
import type { ParsedQuery } from './nlQueryParser'

export interface TelemetryDictionaries {
  site_id: string[]
  serial_number: string[]
  sku_name: string[]
}

let cachedTelemetryDicts: TelemetryDictionaries | null = null

export async function loadTelemetryDictionaries(): Promise<TelemetryDictionaries> {
  if (cachedTelemetryDicts) return cachedTelemetryDicts
  const [sites, serials, skus] = await Promise.all([
    query<{ site_id: string }>('SELECT DISTINCT site_id FROM telemetry WHERE site_id IS NOT NULL ORDER BY site_id'),
    query<{ serial_number: string }>('SELECT DISTINCT serial_number FROM telemetry WHERE serial_number IS NOT NULL ORDER BY serial_number LIMIT 500'),
    query<{ sku_name: string }>('SELECT DISTINCT sku_name FROM telemetry WHERE sku_name IS NOT NULL ORDER BY sku_name'),
  ])
  cachedTelemetryDicts = {
    site_id: sites.map((r) => r.site_id),
    serial_number: serials.map((r) => r.serial_number),
    sku_name: skus.map((r) => r.sku_name),
  }
  return cachedTelemetryDicts
}

export function clearTelemetryDictionaries(): void {
  cachedTelemetryDicts = null
}

function escapeSql(v: string): string {
  return v.replace(/'/g, "''")
}

/** Extract desired row/result limit from the user's question. */
export function extractLimit(question: string, def = 20): number {
  const lower = question.toLowerCase()
  if (/\ball\b|no\s*limit|everything/.test(lower)) return 1000
  const m = lower.match(/\b(?:top|show|give|limit|fetch|return|get)\s+(\d+)\b/)
    ?? lower.match(/\b(\d+)\s*(?:rows?|results?|records?|entries)\b/)
    ?? lower.match(/\b(?:first|last)\s+(\d+)\b/)
  if (m) return Math.min(parseInt(m[1], 10), 1000)
  return def
}

function matchSiteId(question: string, dicts: TelemetryDictionaries): string | null {
  const lower = question.toLowerCase()
  for (const sid of dicts.site_id) {
    if (lower.includes(sid.toLowerCase())) return sid
  }
  return null
}

function matchSerialNumber(question: string, dicts: TelemetryDictionaries): string | null {
  const lower = question.toLowerCase()
  for (const sn of dicts.serial_number) {
    if (lower.includes(sn.toLowerCase())) return sn
  }
  return null
}

function matchSku(question: string, dicts: TelemetryDictionaries): string | null {
  const lower = question.toLowerCase()
  for (const sku of dicts.sku_name) {
    if (sku && lower.includes(sku.toLowerCase())) return sku
  }
  return null
}

function buildWhere(siteId: string | null, serial: string | null, sku: string | null): string {
  const parts: string[] = []
  if (siteId) parts.push(`site_id = '${escapeSql(siteId)}'`)
  if (serial) parts.push(`serial_number = '${escapeSql(serial)}'`)
  if (sku) parts.push(`sku_name = '${escapeSql(sku)}'`)
  return parts.length > 0 ? parts.join(' AND ') : '1=1'
}

function buildMatched(siteId: string | null, serial: string | null, sku: string | null): Record<string, string> {
  const m: Record<string, string> = {}
  if (siteId) m['site_id'] = siteId
  if (serial) m['serial_number'] = serial
  if (sku) m['sku_name'] = sku
  return m
}

/**
 * Parses a telemetry-targeted natural-language question into SQL.
 * Returns confidence 'low' when no recognizable pattern is found —
 * callers should fall back to the LLM.
 */
export function parseTelemetryQuestion(
  question: string,
  dicts: TelemetryDictionaries
): ParsedQuery {
  const lower = question.toLowerCase()
  const lim = extractLimit(question, 20)
  const siteId = matchSiteId(question, dicts)
  const serial = matchSerialNumber(question, dicts)
  const sku = matchSku(question, dicts)
  const where = buildWhere(siteId, serial, sku)
  const matched = buildMatched(siteId, serial, sku)
  const filterDesc = Object.values(matched).join(', ') || 'all data'

  // ── Domain-aware: Vmp crossing check ──
  if (/\bvmp\b/i.test(question) || (/\bnot\s+cross|never\s+reach|below\b|under\b/i.test(lower) && /\bvoltage\b|\bvdc\b/i.test(lower))) {
    // Extract user-specified voltage: "Vmp 40V", "below 30 V", "not crossing 28.5 volts", etc.
    const voltMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:v(?:olts?)?|vdc)\b/)
      ?? lower.match(/vmp\s+(\d+(?:\.\d+)?)/)
      ?? lower.match(/(?:below|under|less\s+than|<)\s*(\d+(?:\.\d+)?)/)
      ?? lower.match(/(?:threshold|crossing|cross|reach)\s+(\d+(?:\.\d+)?)/)
    const vmpVoltage = voltMatch ? parseFloat(voltMatch[1]) : 35
    const isDefault = !voltMatch
    return {
      sql: `SELECT serial_number, site_id, sku_name, ROUND(MAX(dc_voltage), 2) AS max_dc_voltage, COUNT(*) AS readings FROM telemetry WHERE ${where} AND dc_voltage IS NOT NULL GROUP BY serial_number, site_id, sku_name HAVING MAX(dc_voltage) < ${vmpVoltage} ORDER BY max_dc_voltage ASC LIMIT 50`,
      confidence: 'high',
      explanation: `Inverters whose DC voltage never exceeded ${vmpVoltage}V${isDefault ? ' (default — specify a value like "Vmp 40V" to customize)' : ''}, filtered by: ${filterDesc}. These modules may have shading, mismatch, or undersized strings.`,
      matchedEntities: matched,
      caveat: isDefault ? 'Using 35V as a generic Vmp threshold. Specify your module\'s Vmp in the question (e.g. "not crossing Vmp 40V").' : undefined,
    }
  }

  // ── Domain-aware: Aggregate / inverter-wise clipping ──
  if (/\bclipping\b|\bclip\b|\bflat\s*run\b|\bpower\s*limit/i.test(lower)) {
    const isAggregate = /\binverter.?wise\b|\bper\s+inverter\b|\bby\s+inverter\b|\baggregate\b|\bsummary\b|\bsummar[iy]z/i.test(lower)
    if (isAggregate) {
      return {
        sql: `SELECT serial_number, site_id, sku_name, ROUND(AVG(CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END), 1) AS avg_ac_power_w, ROUND(MAX(CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END), 1) AS peak_ac_power_w, ROUND(AVG(dc_current * dc_voltage), 1) AS avg_dc_power_w, ROUND(MAX(dc_current * dc_voltage), 1) AS peak_dc_power_w, ROUND(AVG(dc_voltage), 2) AS avg_dc_voltage, COUNT(*) AS total_readings FROM telemetry WHERE ${where} AND dc_current IS NOT NULL GROUP BY serial_number, site_id, sku_name ORDER BY peak_dc_power_w DESC LIMIT ${lim}`,
        confidence: 'high',
        explanation: `Aggregate power summary per inverter for clipping analysis, filtered by: ${filterDesc}. Inverters with peak DC power >> avg AC power are likely clipping.`,
        matchedEntities: matched,
      }
    }
    return {
      sql: `SELECT serial_number, site_id, sku_name, CAST(DATE_TRUNC('hour', timestamp) AS VARCHAR) AS hour, AVG(CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END) AS ac_power, AVG(dc_current) AS dc_current, AVG(dc_voltage) AS dc_voltage, COUNT(*) AS sample_count FROM telemetry WHERE ${where} AND dc_current IS NOT NULL GROUP BY serial_number, site_id, sku_name, DATE_TRUNC('hour', timestamp) ORDER BY serial_number, hour LIMIT ${lim}`,
      confidence: 'high',
      explanation: `Hourly AC power and DC current/voltage data for clipping analysis, filtered by: ${filterDesc}. Use the Clipping Analysis page for full detection.`,
      matchedEntities: matched,
    }
  }

  // ── Domain-aware: Underperforming / anomaly / z-score ──
  if (/\bunderperform|\bz-?score\b|\banomaly|\banomalies\b|\boutlier/i.test(lower)) {
    return {
      sql: `SELECT t.serial_number, t.site_id, t.sku_name, SUM(t.energy_produced) AS total_energy, s.site_mean, s.site_std, CASE WHEN s.site_std > 0 THEN ROUND((SUM(t.energy_produced) - s.site_mean) / s.site_std, 2) ELSE 0 END AS z_score FROM telemetry t INNER JOIN (SELECT site_id, AVG(inv_energy) AS site_mean, COALESCE(STDDEV_POP(inv_energy), 0) AS site_std FROM (SELECT site_id, serial_number, SUM(energy_produced) AS inv_energy FROM telemetry WHERE ${where} GROUP BY site_id, serial_number) sub GROUP BY site_id) s ON t.site_id = s.site_id WHERE ${where.replace(/1=1/g, '1=1')} GROUP BY t.serial_number, t.site_id, t.sku_name, s.site_mean, s.site_std ORDER BY z_score ASC LIMIT 50`,
      confidence: 'high',
      explanation: `Inverters ranked by z-score (lowest = most underperforming relative to site average), filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── Domain-aware: Night-time leakage ──
  if (/\bnight|\bleakage|\bnight-?time/i.test(lower)) {
    return {
      sql: `SELECT serial_number, site_id, CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date, SUM(energy_produced) AS night_energy_wh, COUNT(*) AS readings FROM telemetry WHERE ${where} AND (EXTRACT(HOUR FROM timestamp) >= 22 OR EXTRACT(HOUR FROM timestamp) <= 5) AND energy_produced > 0 GROUP BY serial_number, site_id, CAST(timestamp AS DATE) HAVING SUM(energy_produced) > 0 ORDER BY night_energy_wh DESC LIMIT ${lim}`,
      confidence: 'high',
      explanation: `Inverters reporting energy production during nighttime (10pm-5am), filtered by: ${filterDesc}. Non-zero night energy may indicate metering errors.`,
      matchedEntities: matched,
    }
  }

  // ── Domain-aware: Temperature / overheating ──
  if (/\btemperature\b|\btemp\b|\bhot\b|\boverheat|\bcool/i.test(lower)) {
    const isHottest = /\bhot|\bhigh|\bmax|\btop|\bwarm|\boverheat/i.test(lower)
    const dir = isHottest ? 'DESC' : 'ASC'
    return {
      sql: `SELECT serial_number, site_id, sku_name, ROUND(AVG((temperature_f - 32) * 5.0 / 9.0), 1) AS avg_temp_c, ROUND(MAX((temperature_f - 32) * 5.0 / 9.0), 1) AS max_temp_c, COUNT(*) AS readings FROM telemetry WHERE ${where} AND temperature_f IS NOT NULL GROUP BY serial_number, site_id, sku_name ORDER BY avg_temp_c ${dir} LIMIT ${lim}`,
      confidence: 'high',
      explanation: `Inverters ranked by average temperature (°C), filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── Domain-aware: Peak power hours ──
  if (/\bpeak\s*(power|hour|time)|\bbest\s*hour/i.test(lower)) {
    return {
      sql: `SELECT EXTRACT(HOUR FROM timestamp) AS hour_of_day, ROUND(AVG(dc_current * dc_voltage), 1) AS avg_dc_power_w, ROUND(AVG(CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END), 1) AS avg_ac_power_w, COUNT(*) AS readings FROM telemetry WHERE ${where} AND dc_current IS NOT NULL AND dc_voltage IS NOT NULL GROUP BY EXTRACT(HOUR FROM timestamp) ORDER BY avg_dc_power_w DESC`,
      confidence: 'high',
      explanation: `Average DC and AC power by hour of day, filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── Domain-aware: Voltage drop / AC voltage analysis ──
  if (/\bvoltage\s*drop|\bac\s*voltage|\bgrid\s*voltage|\bvoltage\s*sag/i.test(lower)) {
    return {
      sql: `SELECT CAST(DATE_TRUNC('hour', timestamp) AS VARCHAR) AS hour, ROUND(AVG(ac_voltage), 2) AS avg_ac_voltage, ROUND(MIN(ac_voltage), 2) AS min_ac_voltage, ROUND(MAX(ac_voltage), 2) AS max_ac_voltage, COUNT(*) AS readings FROM telemetry WHERE ${where} AND ac_voltage IS NOT NULL GROUP BY DATE_TRUNC('hour', timestamp) ORDER BY hour LIMIT 500`,
      confidence: 'high',
      explanation: `Hourly AC voltage trend, filtered by: ${filterDesc}. Look for sustained dips indicating grid voltage sag.`,
      matchedEntities: matched,
    }
  }

  // ── Total energy ──
  if (/\btotal\s*energy|\bsum\s*(of\s*)?energy|\benergy\s*produced/i.test(lower)) {
    return {
      sql: `SELECT ${siteId ? '' : "site_id, "}ROUND(SUM(energy_produced), 2) AS total_energy_wh, ROUND(SUM(energy_produced) / 1000.0, 2) AS total_energy_kwh FROM telemetry WHERE ${where} ${siteId ? '' : `GROUP BY site_id ORDER BY total_energy_wh DESC LIMIT ${lim}`}`,
      confidence: 'high',
      explanation: `Total energy produced (Wh and kWh), filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── Daily energy ──
  if (/\bdaily\s*energy|\benergy\s*(per|by)\s*day|\bday\s*energy/i.test(lower)) {
    return {
      sql: `SELECT ${siteId ? '' : 'site_id, '}CAST(CAST(timestamp AS DATE) AS VARCHAR) AS date, ROUND(SUM(energy_produced), 2) AS daily_energy_wh, ROUND(SUM(energy_produced) / 1000.0, 2) AS daily_energy_kwh FROM telemetry WHERE ${where} GROUP BY ${siteId ? '' : 'site_id, '}CAST(timestamp AS DATE) ORDER BY date DESC LIMIT ${Math.max(lim, 30)}`,
      confidence: 'high',
      explanation: `Daily energy production trend, filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── How many inverters / sites ──
  if (/\bhow\s*many\b|\bcount\b|\bnumber\s*of/i.test(lower)) {
    const isSites = /\bsite/i.test(lower)
    const isInverters = /\binverter|\bserial|\bmicroinverter/i.test(lower)
    if (isSites || isInverters) {
      const countCol = isSites ? 'site_id' : 'serial_number'
      const label = isSites ? 'sites' : 'inverters'
      return {
        sql: `SELECT COUNT(DISTINCT ${countCol}) AS total_${label} FROM telemetry WHERE ${where}`,
        confidence: 'high',
        explanation: `Count of distinct ${label}, filtered by: ${filterDesc}.`,
        matchedEntities: matched,
      }
    }
  }

  // ── Average DC voltage / DC current / DC power ──
  if (/\bavg|\baverage|\bmean/i.test(lower)) {
    if (/\bdc\s*voltage|\bvdc/i.test(lower)) {
      return {
        sql: `SELECT serial_number, site_id, ROUND(AVG(dc_voltage), 2) AS avg_dc_voltage, COUNT(*) AS readings FROM telemetry WHERE ${where} AND dc_voltage IS NOT NULL GROUP BY serial_number, site_id ORDER BY avg_dc_voltage DESC LIMIT ${lim}`,
        confidence: 'high',
        explanation: `Average DC voltage per inverter, filtered by: ${filterDesc}.`,
        matchedEntities: matched,
      }
    }
    if (/\bdc\s*current|\bidc/i.test(lower)) {
      return {
        sql: `SELECT serial_number, site_id, ROUND(AVG(dc_current), 3) AS avg_dc_current, COUNT(*) AS readings FROM telemetry WHERE ${where} AND dc_current IS NOT NULL GROUP BY serial_number, site_id ORDER BY avg_dc_current DESC LIMIT ${lim}`,
        confidence: 'high',
        explanation: `Average DC current per inverter, filtered by: ${filterDesc}.`,
        matchedEntities: matched,
      }
    }
    if (/\bdc\s*power|\bpower/i.test(lower)) {
      return {
        sql: `SELECT serial_number, site_id, ROUND(AVG(dc_current * dc_voltage), 1) AS avg_dc_power_w, COUNT(*) AS readings FROM telemetry WHERE ${where} AND dc_current IS NOT NULL AND dc_voltage IS NOT NULL GROUP BY serial_number, site_id ORDER BY avg_dc_power_w DESC LIMIT ${lim}`,
        confidence: 'high',
        explanation: `Average DC power per inverter, filtered by: ${filterDesc}.`,
        matchedEntities: matched,
      }
    }
  }

  // ── Top / most / highest energy producers ──
  if (/\btop\b|\bmost\b|\bhighest\b|\bbest\b|\bmax/i.test(lower) && /\benergy|\bproduction|\bproduced/i.test(lower)) {
    const limitMatch = lower.match(/top\s+(\d+)/i)
    const lim = limitMatch ? Math.min(parseInt(limitMatch[1], 10), 500) : 20
    return {
      sql: `SELECT serial_number, site_id, sku_name, ROUND(SUM(energy_produced), 2) AS total_energy_wh, COUNT(*) AS readings FROM telemetry WHERE ${where} GROUP BY serial_number, site_id, sku_name ORDER BY total_energy_wh DESC LIMIT ${lim}`,
      confidence: 'high',
      explanation: `Top ${lim} inverters by total energy produced, filtered by: ${filterDesc}.`,
      matchedEntities: matched,
    }
  }

  // ── Low confidence: couldn't match a pattern ──
  const hasSignal = siteId !== null || serial !== null || sku !== null
  return {
    sql: `SELECT serial_number, site_id, sku_name, ROUND(SUM(energy_produced), 2) AS total_energy_wh, ROUND(AVG(dc_current * dc_voltage), 1) AS avg_dc_power_w, ROUND(AVG((temperature_f - 32) * 5.0 / 9.0), 1) AS avg_temp_c, COUNT(*) AS readings FROM telemetry WHERE ${where} GROUP BY serial_number, site_id, sku_name ORDER BY total_energy_wh DESC LIMIT ${lim}`,
    confidence: hasSignal ? 'medium' : 'low',
    explanation: `General inverter summary, filtered by: ${filterDesc}.`,
    matchedEntities: matched,
    caveat: hasSignal
      ? undefined
      : 'Could not identify a specific telemetry pattern. Try asking about energy, voltage, temperature, clipping, anomalies, or Vmp crossing.',
  }
}
