// Smart router: determines whether a natural-language question targets
// the fleet table or the telemetry table based on keyword matching.
// Falls back to fleet when ambiguous (fleet is always available).

const TELEMETRY_KEYWORDS = [
  'energy', 'energy produced', 'kwh', 'wh', 'watt-hour',
  'voltage', 'dc voltage', 'ac voltage', 'vmp', 'voc',
  'current', 'dc current', 'ampere', 'amps',
  'temperature', 'temp', 'celsius', 'fahrenheit', 'hot', 'cold', 'overheat',
  'clipping', 'clip', 'flat run', 'power limit',
  'inverter', 'serial', 'serial number', 'microinverter',
  'daily energy', 'hourly', 'time series', 'timeseries', 'trend',
  'anomaly', 'anomalies', 'z-score', 'zscore', 'outlier', 'underperform',
  'heatmap', 'heat map',
  'power output', 'dc power', 'ac power',
  'frequency', 'ac frequency', 'hz',
  'night', 'nighttime', 'leakage',
  'peak power', 'peak hour',
  'sku', 'model',
  'duration', 'uptime',
  'site energy', 'production',
]

const FLEET_KEYWORDS = [
  'region', 'country', 'tss region', 'tss country', 'region bundle',
  'dc/ac', 'dc ac ratio', 'dc-ac', 'dc/ac ratio',
  'irradiance', 'irradiation', 'ghi', 'solar irradiance',
  'units', 'unit count', 'microinverter count',
  'module wafer', 'wafer', 'g12r', 'm10',
  'product type', 'iq8', 'iq8p', 'iq8m', 'iq7',
  'quarter', 'q1', 'q2', 'q3', 'q4',
  'fleet', 'fleet data',
  'stc rating', 'stc mwdc', 'mwdc', 'mwac', 'capacity',
  'power bucket', 'power block',
  'how many sites',
]

function countMatches(question: string, keywords: string[]): number {
  const lower = question.toLowerCase()
  let count = 0
  for (const kw of keywords) {
    if (lower.includes(kw)) count++
  }
  return count
}

export type QueryTarget = 'fleet' | 'telemetry' | 'both'

/**
 * Routes a question to the most appropriate table.
 * - If only one dataset is loaded, routes there.
 * - If both are loaded, keyword scoring decides.
 * - Ties go to fleet (always available, broader coverage).
 */
export function routeQuestion(
  question: string,
  hasFleet: boolean,
  hasTelemetry: boolean
): QueryTarget {
  if (!hasTelemetry && hasFleet) return 'fleet'
  if (!hasFleet && hasTelemetry) return 'telemetry'
  if (!hasFleet && !hasTelemetry) return 'fleet' // fallback

  const fleetScore = countMatches(question, FLEET_KEYWORDS)
  const telemetryScore = countMatches(question, TELEMETRY_KEYWORDS)

  // Cross-table: both fleet and telemetry signals are strong
  if (fleetScore >= 2 && telemetryScore >= 2) return 'both'

  // Telemetry wins only if it scores strictly higher
  return telemetryScore > fleetScore ? 'telemetry' : 'fleet'
}
