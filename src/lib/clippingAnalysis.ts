// Pure, framework-agnostic clipping-detection logic. Kept separate from the
// React hook/page so the flat-run algorithm can be unit tested and reasoned
// about independently of DuckDB/React Query plumbing.

export interface HourlyPoint {
  site_id: string
  serial_number: string
  sku_name: string | null
  /** DATE_TRUNC('hour', timestamp), cast to VARCHAR by DuckDB (e.g. "2025-06-01 13:00:00"). */
  hour: string
  /** Calendar date (YYYY-MM-DD) — runs never span across this boundary. */
  date: string
  ac_power: number | null
  dc_current: number | null
  dc_voltage: number | null
  /** Hourly-averaged inverter temperature (°F), NULL when not measured. */
  avg_temperature_f: number | null
  /** Hourly-max inverter temperature (°F), NULL when not measured. */
  max_temperature_f: number | null
  sample_count: number
}

export type ClippingType = 'power' | 'current'

export interface ClippingEvent {
  type: ClippingType
  site_id: string
  serial_number: string
  sku_name: string | null
  date: string
  start_hour: string
  end_hour: string
  /** Number of contiguous hourly points that make up this flat run. */
  duration_hours: number
  /** Mean value across the run (W for power, A for current). */
  clipped_value: number
  min_value: number
  max_value: number
  /** Nominal rated AC power (W) for the SKU, if known. */
  rated_capacity: number | null
  /** clipped_value as a % of rated_capacity, if known. */
  pct_of_rated: number | null
  /** For current clipping: avg/max DC voltage and AC power during the clipped run. */
  avg_voltage: number | null
  max_voltage: number | null
  avg_power: number | null
  max_power: number | null
  /** For power clipping: avg/max DC voltage and DC current during the clipped run. */
  avg_current: number | null
  max_current: number | null
  /** Cell/inverter temperature during the clipped run (°C), NULL when telemetry lacks temperature_f. */
  avg_temperature_c: number | null
  /** Peak inverter temperature during the clipped run (°C). */
  max_temperature_c: number | null
}

export interface ClippingOptions {
  /** Tolerance band (W) for treating consecutive AC power readings as "flat". */
  powerBufferW: number
  /** Tolerance band (A) for treating consecutive DC current readings as "flat". */
  currentBufferA: number
  /** Ignore points below this AC power (W) — excludes nighttime/zero-output flatness. */
  minPowerW: number
  /** Ignore points below this DC current (A) — excludes nighttime/zero-output flatness. */
  minCurrentA: number
  /** Minimum number of contiguous hourly points required to call it a clipping event. */
  minConsecutiveHours: number
  /** If true, apply France 94% power factor to rated capacity. */
  isFrance: boolean
}

export const DEFAULT_CLIPPING_OPTIONS: ClippingOptions = {
  powerBufferW: 3,
  currentBufferA: 0.15,
  minPowerW: 30,
  minCurrentA: 0.5,
  minConsecutiveHours: 2,
  isFrance: false,
}

// Approximate nominal rated AC power (W) for common Enphase microinverter
// SKUs. Used only to annotate power-clipping events with a "% of rated
// capacity" figure for extra context — it plays no role in the detection
// algorithm itself (which is purely based on flatness of the observed
// curve), so an imprecise or missing rating never affects what gets
// flagged. Values are nominal/public-spec approximations; adjust as needed.
export const RATED_AC_POWER_W: Record<string, number> = {
  IQ7: 240,
  'IQ7+': 249,
  IQ7X: 290,
  IQ7A: 349,
  IQ7HS: 349,
  IQ7AM: 349,
  IQ7XS: 290,
  IQ7PD: 295,
  IQ7AS: 296,
  IQ8: 240,
  IQ8PLUS: 300,
  'IQ8+': 300,
  IQ8M: 290,
  IQ8MC: 330,
  IQ8H: 349,
  IQ8HC: 384,
  IQ8P: 480,
  'IQ8P-3P': 480,
  IQ8X: 349,
  IQ8D: 366,
  IQ8AC: 366,
  'IQ8H-3P': 349,
  IQ9N: 427,
  'IQ9N-3P-277': 427,
}

/**
 * France has a power factor restriction — inverters can only produce
 * 94% of their rated AC power.
 */
export const FRANCE_POWER_FACTOR = 0.94

function lookupRatedPower(sku: string | null): number | null {
  if (!sku) return null
  const norm = sku.trim().toUpperCase()
  if (RATED_AC_POWER_W[norm] != null) return RATED_AC_POWER_W[norm]
  // Fall back to prefix match (e.g. "IQ8HC-72-2-US" -> "IQ8HC")
  const sorted = Object.keys(RATED_AC_POWER_W).sort((a, b) => b.length - a.length)
  for (const key of sorted) {
    if (norm.startsWith(key)) return RATED_AC_POWER_W[key]
  }
  return null
}

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

interface SeriesPoint {
  hour: string
  value: number
}

interface FlatRun {
  startIdx: number
  endIdx: number
  values: number[]
}

/**
 * Detects sustained "flat" runs in an hourly metric series (power or
 * current) — the classic signature of inverter power-clipping or DC
 * current-limiting. A run is a set of >= minConsecutiveHours contiguous
 * hourly points whose values stay within `buffer` of the run's rolling
 * mean (absorbing gentle drift rather than comparing to a fixed reference),
 * while remaining above `minValue` so nighttime/zero-output flatness is
 * never reported as clipping. A gap of more than 1.5 hours between
 * consecutive points breaks the run (handles missing/sparse data).
 */
function findFlatRuns(
  points: SeriesPoint[],
  buffer: number,
  minValue: number,
  minConsecutiveHours: number
): FlatRun[] {
  const runs: FlatRun[] = []
  let runStart = -1
  let runValues: number[] = []

  const flush = (endIdx: number) => {
    if (runStart >= 0 && runValues.length >= minConsecutiveHours) {
      runs.push({ startIdx: runStart, endIdx, values: [...runValues] })
    }
    runStart = -1
    runValues = []
  }

  for (let i = 0; i < points.length; i++) {
    const { value } = points[i]

    if (value < minValue) {
      flush(i - 1)
      continue
    }

    if (runStart >= 0) {
      const prevTime = new Date(points[i - 1].hour).getTime()
      const curTime = new Date(points[i].hour).getTime()
      const gapHours = (curTime - prevTime) / 3_600_000
      const runMean = runValues.reduce((a, b) => a + b, 0) / runValues.length

      if (Number.isFinite(gapHours) && gapHours <= 1.5 && Math.abs(value - runMean) <= buffer) {
        runValues.push(value)
        continue
      }
      flush(i - 1)
    }

    runStart = i
    runValues = [value]
  }
  flush(points.length - 1)

  return runs
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function runToEvent(
  type: ClippingType,
  run: FlatRun,
  sorted: HourlyPoint[],
  rated: number | null,
  isFrance: boolean
): ClippingEvent {
  const { values, startIdx, endIdx } = run
  const clipped = avg(values)
  const startHour = sorted[startIdx].hour
  const endHour = sorted[endIdx].hour
  const startMs = new Date(startHour).getTime()
  const endMs = new Date(endHour).getTime()
  const durationHours = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.round((endMs - startMs) / 3_600_000) + 1
    : values.length

  // Companion metrics from the same hourly points in the flat run
  const runPoints = sorted.slice(startIdx, endIdx + 1)
  const voltages = runPoints.map((r) => safe(r.dc_voltage))
  const powers = runPoints.map((r) => safe(r.ac_power))
  const currents = runPoints.map((r) => safe(r.dc_current))

  // Temperature: collect non-null readings and convert °F → °C
  const fToC = (f: number) => (f - 32) * 5 / 9
  const validTempsC = runPoints
    .map((r) => r.avg_temperature_f)
    .filter((v): v is number => v != null && Number.isFinite(v))
    .map(fToC)
  const validMaxTempsC = runPoints
    .map((r) => r.max_temperature_f)
    .filter((v): v is number => v != null && Number.isFinite(v))
    .map(fToC)
  const avgTempC = validTempsC.length > 0 ? avg(validTempsC) : null
  const maxTempC = validMaxTempsC.length > 0 ? Math.max(...validMaxTempsC) : null

  // Effective rated capacity — France sites can only output 94% of nominal
  const effectiveRated = rated != null
    ? (isFrance ? rated * FRANCE_POWER_FACTOR : rated)
    : null

  // % of rated = Average AC Power / Effective Rated Power
  // For power clipping: avg power IS the clipped value (already in W)
  // For current clipping: use the companion avg_power metric
  const avgPowerW = type === 'power' ? clipped : avg(powers)
  const pctOfRated = effectiveRated && avgPowerW > 0
    ? (avgPowerW / effectiveRated) * 100
    : null

  return {
    type,
    site_id: sorted[0].site_id,
    serial_number: sorted[0].serial_number,
    sku_name: sorted[0].sku_name,
    date: sorted[0].date,
    start_hour: startHour,
    end_hour: endHour,
    duration_hours: durationHours,
    clipped_value: clipped,
    min_value: Math.min(...values),
    max_value: Math.max(...values),
    rated_capacity: effectiveRated,
    pct_of_rated: pctOfRated,
    // Current clipping companions: voltage + power
    avg_voltage: type === 'current' ? avg(voltages) : (type === 'power' ? avg(voltages) : null),
    max_voltage: type === 'current' ? Math.max(...voltages) : (type === 'power' ? Math.max(...voltages) : null),
    avg_power: type === 'current' ? avg(powers) : null,
    max_power: type === 'current' ? Math.max(...powers) : null,
    // Power clipping companions: current
    avg_current: type === 'power' ? avg(currents) : null,
    max_current: type === 'power' ? Math.max(...currents) : null,
    // Temperature during the clipping event (both types)
    avg_temperature_c: avgTempC,
    max_temperature_c: maxTempC,
  }
}

/**
 * Runs power-clipping and current-clipping detection across every
 * (serial_number, date) group in `rows`, independently. Returned events are
 * sorted by duration (longest first) so the most significant clipping shows
 * up at the top of any results table by default.
 */
export function detectClippingEvents(
  rows: HourlyPoint[],
  opts: ClippingOptions = DEFAULT_CLIPPING_OPTIONS
): ClippingEvent[] {
  const events: ClippingEvent[] = []

  const groups = new Map<string, HourlyPoint[]>()
  for (const row of rows) {
    const key = `${row.serial_number}__${row.date}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort((a, b) => a.hour.localeCompare(b.hour))
    if (sorted.length === 0) continue
    const rated = lookupRatedPower(sorted[0].sku_name)

    const powerPoints: SeriesPoint[] = sorted.map((r) => ({ hour: r.hour, value: safe(r.ac_power) }))
    const powerRuns = findFlatRuns(powerPoints, opts.powerBufferW, opts.minPowerW, opts.minConsecutiveHours)
    for (const run of powerRuns) events.push(runToEvent('power', run, sorted, rated, opts.isFrance))

    const currentPoints: SeriesPoint[] = sorted.map((r) => ({ hour: r.hour, value: safe(r.dc_current) }))
    const currentRuns = findFlatRuns(currentPoints, opts.currentBufferA, opts.minCurrentA, opts.minConsecutiveHours)
    for (const run of currentRuns) events.push(runToEvent('current', run, sorted, rated, opts.isFrance))
  }

  events.sort((a, b) => b.duration_hours - a.duration_hours)
  return events
}
