// Stage 2 — Explainer LLM: converts a validated tool result into a natural language narrative.
// The Explainer NEVER invents numbers. It ONLY interprets the validated result provided.
// Streaming tokens are forwarded to the UI via the onToken callback.

import type { LLMProvider, CompletionResult } from './llmProvider'
import type { ToolResult } from './analyticsTools'
import type { AnalysisRequest } from './intentRouter'

// ─── Result summarizer ────────────────────────────────────────────────────────

const MAX_SUMMARY_CHARS = 600
const MAX_SITE_ANALYSIS_CHARS = 3200

/** Compact JSON summary for the analyze_site multi-section result. */
function summarizeSiteAnalysis(row: Record<string, unknown>): string {
  const parts: string[] = [`Site: ${row['site_id'] ?? '?'}`]

  const fleet = row['fleet_summary'] as Record<string, unknown> | null
  if (fleet) {
    parts.push(`Location: ${fleet['city'] ?? ''}, ${fleet['state'] ?? ''}, ${fleet['country'] ?? ''} (${fleet['region'] ?? ''})`)
    parts.push(`Inverter: ${fleet['product_type'] ?? '?'} (${fleet['device_type'] ?? ''}) | Model: ${fleet['model_name'] ?? '?'}`)
    parts.push(`Module: ${fleet['pv_module_make'] ?? '?'} ${fleet['pv_module_model'] ?? ''} | Wafer: ${fleet['module_wafer'] ?? '?'} | STC: ${fleet['stc_rating_w'] ?? '?'}W`)
    parts.push(`DC/AC: ${fleet['dc_ac_ratio'] ?? '?'} | Units: ${fleet['unit_count'] ?? '?'} | Irradiance: ${fleet['irradiance_kwh_m2_month'] ?? '?'} kWh/m2/day`)
    parts.push(`Voc: ${fleet['voc'] ?? '?'}V | Isc: ${fleet['isc'] ?? '?'}A | MWdc: ${fleet['stc_mwdc'] ?? '?'} | MWac: ${fleet['mwac'] ?? '?'}`)
    const grid = fleet['grid_profile'] as Record<string, unknown> | undefined
    if (grid) parts.push(`Grid profile: ${grid['voltage_v'] ?? '?'}V / ${grid['frequency_hz'] ?? '?'}Hz · ${grid['phase'] ?? '?'} · ${grid['note'] ?? ''}`)
  } else {
    parts.push(`Fleet: ${row['fleet_note'] ?? 'Not found in Fleet data.'}`)
  }

  // Peer comparable sites — v2 similarity scoring
  const peers = row['comparable_sites'] as Record<string, unknown>[] | undefined
  if (peers && peers.length > 0) {
    const peerLines = peers.map(p => {
      const sc = p['scores'] as Record<string, number | null> | undefined
      const scoreStr = sc
        ? `geo=${(sc['geography'] ?? 0).toFixed(2)}/3.0,pwr=${sc['module_power'] != null ? (sc['module_power']).toFixed(2) : 'n/a'}/2.0,micro=${sc['microinverter'] != null ? (sc['microinverter']).toFixed(2) : 'n/a'}/2.5,wafer=${sc['wafer'] != null ? (sc['wafer']).toFixed(2) : 'n/a'}/2.0,irr=${sc['irradiance'] != null ? (sc['irradiance']).toFixed(2) : 'n/a'}/0.5`
        : ''
      return `${p['site_id']}[score=${Number(p['total_score'] ?? 0).toFixed(2)}/10|cov=${p['coverage']}%|${p['distance_km']}km|${scoreStr}|tel:${p['telemetry_available'] ? 'yes' : 'no'}]`
    })
    parts.push(`Comparable sites (${peers.length}, v2 algorithm): ${peerLines.join('; ')}`)
  } else {
    parts.push(`Comparable sites: None found within 300 km`)
  }

  if (row['telemetry_available']) {
    const tov = row['telemetry_overview'] as Record<string, unknown> | undefined
    if (tov) {
      parts.push(`Telemetry: ${tov['microinverter_count']} micros, ${tov['total_readings']} readings, ${tov['days_of_data']} days (${tov['first_reading']} to ${tov['last_reading']})`)
    }
    const se = row['site_energy'] as Record<string, unknown> | undefined
    if (se) {
      parts.push(`Site Energy: ${Number(se['total_energy_kwh'] ?? 0).toFixed(1)} kWh (${Number(se['total_energy_mwh'] ?? 0).toFixed(3)} MWh) | Avg AC: ${Number(se['avg_ac_power_w'] ?? 0).toFixed(1)}W | Avg DC: ${Number(se['avg_dc_power_w'] ?? 0).toFixed(1)}W | Avg Temp: ${Number(se['avg_temperature_c'] ?? 0).toFixed(1)}°C`)
    }
    // Daily production trend
    const prod = row['production'] as Record<string, unknown> | undefined
    if (prod) {
      parts.push(`Daily Production: avg=${Number(prod['avg_daily_kwh'] ?? 0).toFixed(1)}kWh | median=${Number(prod['median_daily_kwh'] ?? 0).toFixed(1)}kWh | min=${Number(prod['min_daily_kwh'] ?? 0).toFixed(1)}kWh | max=${Number(prod['max_daily_kwh'] ?? 0).toFixed(1)}kWh | trend=${prod['trend']} | ${prod['valid_days']} valid days`)
    }
    parts.push(`Microinverter count: ${row['microinverter_count'] ?? '?'}`)
    const top = row['top_performers'] as Record<string, unknown>[] | undefined
    if (top?.length) {
      parts.push(`Top performers: ${top.map(t => `${t['serial_number']}(${Number(t['energy_kwh'] ?? 0).toFixed(1)}kWh)`).join(', ')}`)
    }
    const bot = row['bottom_performers'] as Record<string, unknown>[] | undefined
    if (bot?.length) {
      parts.push(`Bottom performers: ${bot.map(t => `${t['serial_number']}(${Number(t['energy_kwh'] ?? 0).toFixed(1)}kWh)`).join(', ')}`)
    }
    const anom = row['anomaly_summary'] as Record<string, unknown> | undefined
    if (anom) {
      parts.push(`Anomalies: ${anom['alerts']} alerts, ${anom['warnings']} warnings, ${anom['normal']} normal (of ${anom['total_inverters_analyzed']})`)
    }
    const alerts = row['anomaly_alerts'] as Record<string, unknown>[] | undefined
    if (alerts?.length) {
      parts.push(`Alert inverters: ${alerts.map(a => `${a['serial_number']}(z=${Number(a['z_score'] ?? 0).toFixed(2)}, ${Number(a['energy_kwh'] ?? 0).toFixed(1)}kWh vs mean ${Number(a['site_mean_kwh'] ?? 0).toFixed(1)}kWh)`).join(', ')}`)
    }
    // Clipping
    const clip = row['clipping'] as Record<string, unknown> | undefined
    if (clip) {
      parts.push(`Clipping: classification=${clip['classification']} | power=${clip['power']} (${clip['power_event_count']} events) | current=${clip['current']} (${clip['current_event_count']} events) | affected_days=${clip['affected_days']}`)
      const clipDates = clip['clipping_dates'] as string[] | undefined
      if (clipDates?.length) parts.push(`Clipping dates: ${clipDates.join(', ')}`)
    }
    // Clipping reasons
    const clipReasons = row['clipping_reasons'] as Record<string, unknown> | undefined
    if (clipReasons) {
      const cur = clipReasons['current_clipping'] as Record<string, unknown> | undefined
      const pwr = clipReasons['power_clipping'] as Record<string, unknown> | undefined
      if (cur) {
        const flag = cur['consistency_flag'] ? ` FLAG:${cur['consistency_flag']}` : ''
        parts.push(`Current clipping diagnosis: char=${cur['characteristic_current_a']}A, range=${cur['min_clipped_a']}-${cur['max_clipped_a']}A, variation=${cur['variation_a']}A, consistent=${cur['is_consistent']}${flag}`)
      }
      if (pwr) {
        parts.push(`Power clipping diagnosis: char=${pwr['characteristic_power_w']}W, rated=${pwr['rated_ac_capacity_w'] ?? 'unknown'}W, %rated=${pwr['pct_of_rated'] ?? 'n/a'}%, at_rated=${pwr['is_at_rated_capacity']} | ${pwr['assessment']}`)
      }
    }
    // Per-microinverter AC power stats
    const acPower = row['microinverter_ac_power'] as Record<string, unknown>[] | undefined
    if (acPower?.length) {
      const lines = acPower.slice(0, 10).map(m => `${m['serial_number']}[max=${Number(m['max_ac_power_w'] ?? 0).toFixed(0)}W,median=${Number(m['median_ac_power_w'] ?? 0).toFixed(0)}W,avg=${Number(m['avg_ac_power_w'] ?? 0).toFixed(0)}W]`)
      parts.push(`Microinverter AC power: ${lines.join('; ')}`)
    }
    // Per-microinverter environment
    const env = row['microinverter_environment'] as Record<string, unknown>[] | undefined
    if (env?.length) {
      const lines = env.slice(0, 10).map(m => `${m['serial_number']}[V=${Number(m['avg_ac_voltage_v'] ?? 0).toFixed(1)}V,Hz=${Number(m['avg_ac_frequency_hz'] ?? 0).toFixed(2)}Hz,T=${Number(m['avg_temp_c'] ?? 0).toFixed(1)}°C]`)
      parts.push(`Microinverter environment: ${lines.join('; ')}`)
    }
    // Inverter mismatch
    const mm = row['inverter_mismatch'] as Record<string, unknown> | undefined
    if (mm?.['has_mismatch']) {
      const fi = mm['flagged_inverters'] as Record<string, unknown>[] | undefined
      const flagStrs = fi?.slice(0, 5).map(f => `${f['serial_number']}[AC${f['avg_ac_power_w']}W(${f['power_dev_pct']}%),I${f['avg_dc_current_a']}A(${f['current_dev_pct']}%),V${f['avg_dc_voltage_v']}V(${f['voltage_dev_pct']}%)]`) ?? []
      parts.push(`Inverter mismatch: ${mm['flagged_count']}/${mm['total_analyzed']} deviate >20% from site median | medians: AC=${mm['site_median_power_w']}W, I=${mm['site_median_current_a']}A, V=${mm['site_median_voltage_v']}V | flagged: ${flagStrs.join('; ')}`)
    }
    // Peer benchmarking
    const bench = row['peer_benchmarking'] as Record<string, unknown> | undefined
    if (bench) {
      const lowConf = bench['low_confidence'] ? ' [LOW CONFIDENCE - only 1 peer]' : ''
      parts.push(`Peer Benchmarking${lowConf}: target_avg=${Number(bench['target_avg_daily_kwh'] ?? 0).toFixed(1)}kWh/day | peer_avg=${Number(bench['peer_avg_daily_kwh'] ?? 0).toFixed(1)}kWh/day | peer_median=${Number(bench['peer_median_daily_kwh'] ?? 0).toFixed(1)}kWh/day | deviation=${bench['deviation_pct'] !== null ? `${bench['deviation_pct']}%` : 'N/A'} | ${bench['peers_analyzed']} peers | period: ${bench['comparison_period']}`)
    } else if (peers && peers.length > 0) {
      parts.push(`Peer Benchmarking: Not available (no peer telemetry in this dataset)`)
    }
    // RMA / nearby 10km
    const siteRma = row['site_rma'] as Record<string, unknown> | undefined
    if (siteRma) {
      parts.push(`RMA for site ${row['site_id']}: ${siteRma['rma_available'] ? siteRma['rma_count'] : 'RMA data not loaded'}`)
    }
    const rma = row['rma_summary'] as Record<string, unknown> | undefined
    if (rma) {
      if (rma['note']) {
        parts.push(`RMA/nearby: ${rma['note']}`)
      } else {
        parts.push(`RMA/nearby: ${rma['nearby_site_count']} sites within 10km | total nearby RMA=${rma['rma_total_nearby'] ?? 'N/A'}`)
      }
    }
  } else {
    parts.push(`Telemetry: ${row['telemetry_note'] ?? 'Not available for this site.'}`)
  }

  const joined = parts.join('\n')
  return joined.length > MAX_SITE_ANALYSIS_CHARS
    ? joined.slice(0, MAX_SITE_ANALYSIS_CHARS) + '...(truncated)'
    : joined
}

/** Compact summary for fleet_search results — list of matching sites with key fields. */
function summarizeFleetSearchResult(rows: Record<string, unknown>[], meta: Record<string, unknown>): string {
  const params = meta['params'] as Record<string, unknown> | undefined
  const filters: string[] = []
  if (params?.['microinverter']) filters.push(`inverter=${params['microinverter']}`)
  if (params?.['minPowerW'] != null || params?.['maxPowerW'] != null) {
    filters.push(`power=${params['minPowerW'] ?? 0}–${params['maxPowerW'] ?? '∞'}W`)
  }
  if (params?.['country'])     filters.push(`country=${params['country']}`)
  if (params?.['state'])       filters.push(`state=${params['state']}`)
  if (params?.['irradiance'])  filters.push(`irradiance=${params['irradiance']}`)
  if (params?.['moduleWafer']) filters.push(`wafer=${params['moduleWafer']}`)
  if (params?.['moduleMake'])  filters.push(`module_make=${params['moduleMake']}`)

  const header = `Fleet search results: ${rows.length} site(s) found | Filters: ${filters.join(', ') || 'none'}`
  if (rows.length === 0) return `${header}\nNo sites matched these criteria. Try relaxing the power range or removing a filter.`

  const lines = rows.map((r, i) =>
    `#${i + 1} Site ${r['site_id']} | ${r['city'] ?? ''}, ${r['state'] ?? ''}, ${r['country'] ?? ''} | ` +
    `Inverter: ${r['model_name'] ?? r['product_type'] ?? 'n/a'} | ` +
    `Module: ${r['pv_module_make'] ?? ''} ${r['pv_module_model'] ?? ''} ${r['stc_rating_w'] ?? ''}W | ` +
    `Wafer: ${r['module_wafer'] ?? 'n/a'} | ` +
    `Irr: ${r['irr_ann_kwh_m2_month'] ?? 'n/a'} kWh/m²/mo | ` +
    `DC/AC: ${r['dc_ac_ratio'] ?? 'n/a'} | ` +
    `Units: ${r['unit_count'] ?? 'n/a'}`
  )
  return `${header}\n\n${lines.join('\n')}`
}

/** Compact summary for analyze_microinverter results. */
function summarizeMicroinverterAnalysis(row: Record<string, unknown>): string {
  const parts: string[] = [`Serial: ${row['serial_number'] ?? '?'} | Site: ${row['site_id'] ?? '?'}`]
  const fleet = row['fleet_summary'] as Record<string, unknown> | undefined
  if (fleet) {
    parts.push(`Location: ${fleet['city'] ?? ''}, ${fleet['state'] ?? ''}, ${fleet['country'] ?? ''}`)
    parts.push(`Model: ${fleet['model_name'] ?? '?'} | Module: ${fleet['pv_module_make'] ?? '?'} ${fleet['pv_module_model'] ?? ''} | STC: ${fleet['stc_rating_w'] ?? '?'}W`)
  }
  const ov = row['overview'] as Record<string, unknown> | undefined
  if (ov) {
    parts.push(`Overview: energy=${Number(ov['energy_kwh'] ?? 0).toFixed(1)}kWh | readings=${ov['reading_count'] ?? '?'} | days=${ov['day_count'] ?? '?'} | avg AC=${Number(ov['avg_ac_power_w'] ?? 0).toFixed(0)}W | max temp=${Number(ov['max_temp_c'] ?? 0).toFixed(1)}°C`)
  }
  const ac = row['ac_power'] as Record<string, unknown> | undefined
  if (ac) {
    parts.push(`AC power: max=${Number(ac['max_ac_power_w'] ?? 0).toFixed(0)}W | median=${Number(ac['median_ac_power_w'] ?? 0).toFixed(0)}W | avg=${Number(ac['avg_ac_power_w'] ?? 0).toFixed(0)}W | min=${Number(ac['min_ac_power_w'] ?? 0).toFixed(0)}W`)
  }
  const env = row['environment'] as Record<string, unknown> | undefined
  if (env) {
    parts.push(`Environment: avg AC voltage=${Number(env['avg_ac_voltage_v'] ?? 0).toFixed(1)}V | avg AC freq=${Number(env['avg_ac_frequency_hz'] ?? 0).toFixed(2)}Hz | avg temp=${Number(env['avg_temp_c'] ?? 0).toFixed(1)}°C`)
    parts.push(`Environment ranges: voltage ${Number(env['min_ac_voltage_v'] ?? 0).toFixed(1)}-${Number(env['max_ac_voltage_v'] ?? 0).toFixed(1)}V | freq ${Number(env['min_ac_frequency_hz'] ?? 0).toFixed(2)}-${Number(env['max_ac_frequency_hz'] ?? 0).toFixed(2)}Hz | temp ${Number(env['min_temp_c'] ?? 0).toFixed(1)}-${Number(env['max_temp_c'] ?? 0).toFixed(1)}°C`)
  }
  const daily = row['daily_production'] as Record<string, unknown> | undefined
  if (daily) {
    parts.push(`Daily production: days=${daily['days']} | avg=${Number(daily['avg_daily_kwh'] ?? 0).toFixed(1)}kWh | median=${Number(daily['median_daily_kwh'] ?? 0).toFixed(1)}kWh | min=${Number(daily['min_daily_kwh'] ?? 0).toFixed(1)}kWh | max=${Number(daily['max_daily_kwh'] ?? 0).toFixed(1)}kWh`)
  }
  const clip = row['clipping'] as Record<string, unknown> | undefined
  if (clip) {
    parts.push(`Clipping: classification=${clip['classification']} | total events=${clip['total_event_count']}`)
    const events = clip['events'] as Record<string, unknown>[] | undefined
    if (events?.length) {
      parts.push(`Top events: ${events.slice(0, 5).map(e => `${e['date']} ${e['start_hour']}:00-${e['end_hour']}:00 (${e['duration_hours']}h ${e['type']})`).join('; ')}`)
    }
  }
  return parts.join('\n')
}

/** Compact summary for find_nearby_sites results — passes v2 score breakdown to the LLM. */
function summarizeNearbyResult(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return 'No comparable sites found within the search radius.'
  const lines = rows.map((r, i) => {
    const sc = r['scores'] as Record<string, number | null> | undefined
    const scoreStr = sc
      ? `geo=${(sc['geography'] ?? 0).toFixed(2)}/3.0, power=${sc['module_power'] != null ? sc['module_power'].toFixed(2) : 'n/a'}/2.0, micro=${sc['microinverter'] != null ? sc['microinverter'].toFixed(2) : 'n/a'}/2.5, wafer=${sc['wafer'] != null ? sc['wafer'].toFixed(2) : 'n/a'}/2.0, irr=${sc['irradiance'] != null ? sc['irradiance'].toFixed(2) : 'n/a'}/0.5`
      : 'breakdown unavailable'
    const modStr = r['has_module_info'] ? `${r['pv_module_make'] ?? ''} ${r['pv_module_model'] ?? ''}`.trim() : 'no module data'
    return `#${i + 1} Site ${r['site_id']} | ${r['distance_km']} km | Score: ${Number(r['total_score'] ?? 0).toFixed(2)}/10 | Coverage: ${r['coverage']}% | ${scoreStr} | Inverter: ${r['model_name'] ?? 'n/a'} | Module: ${modStr} | Power: ${r['stc_rating2'] != null ? r['stc_rating2'] + 'W' : 'n/a'} | Wafer: ${r['module_wafer'] ?? 'n/a'} | Location: ${r['location']}`
  })
  return `Comparable sites found: ${rows.length}\nAlgorithm: v2 (Geography 3pts + Module Power 2pts + Microinverter 2.5pts + Wafer 2pts + Irradiance 0.5pts = 10pts max)\n\n${lines.join('\n')}`
}

/**
 * Converts a ToolResult into a compact, token-efficient summary string
 * for injection into the Explainer prompt. Never dumps raw row arrays.
 */
function summarizeResult(result: ToolResult, request: AnalysisRequest): string {
  const { rows, metadata } = result

  if (rows.length === 0) {
    return `Tool: ${metadata.tool} | Result: No data found. ${metadata.warning ?? ''}`
  }

  // Specialized summarizer for site analysis
  if (metadata.tool === 'analyze_site' && rows.length === 1) {
    return summarizeSiteAnalysis(rows[0] as Record<string, unknown>)
  }

  // Specialized summarizer for microinverter analysis
  if (metadata.tool === 'analyze_microinverter' && rows.length === 1) {
    return summarizeMicroinverterAnalysis(rows[0] as Record<string, unknown>)
  }

  if (metadata.tool === 'find_nearby_sites') {
    return summarizeNearbyResult(rows as Record<string, unknown>[])
  }

  if (metadata.tool === 'fleet_search') {
    return summarizeFleetSearchResult(
      rows as Record<string, unknown>[],
      metadata as unknown as Record<string, unknown>
    )
  }

  const parts: string[] = [
    `Tool: ${metadata.tool}`,
    `Rows: ${metadata.rowCount}`,
    `ExecMs: ${metadata.executionMs}`,
  ]

  if (metadata.warning) parts.push(`Note: ${metadata.warning}`)

  // For unanswerable
  if (metadata.tool === 'unanswerable') {
    return `Tool: unanswerable | Note: ${metadata.warning}`
  }

  // Include first 5 rows as JSON, trimmed to budget
  const sample = rows.slice(0, 5)
  const sampleStr = JSON.stringify(sample)
  const preview = sampleStr.length > MAX_SUMMARY_CHARS
    ? sampleStr.slice(0, MAX_SUMMARY_CHARS) + '...(truncated)'
    : sampleStr

  parts.push(`Sample rows: ${preview}`)

  if (request.aggregation) parts.push(`Aggregation: ${request.aggregation}`)
  if (request.metric)      parts.push(`Metric: ${request.metric}`)
  if (request.groupBy)     parts.push(`GroupBy: ${request.groupBy.join(', ')}`)

  return parts.join(' | ')
}

// ─── System prompt ────────────────────────────────────────────────────────────

const EXPLAINER_SYSTEM = `You are a solar energy analytics assistant explaining query results to a fleet operations analyst.

CRITICAL RULES:
1. NEVER invent, estimate, or extrapolate numbers not present in the result data.
2. ONLY interpret and explain the actual data provided in the Result section.
3. If the result is empty or the tool returned no data, say so clearly and suggest why.
4. Keep your response concise — 2 to 5 sentences for simple queries. For comprehensive site analyses, use structured sections with headers.
5. Round numbers sensibly (e.g. "384 kWh" not "384.238473 kWh").
6. When comparing two groups, state which is higher/lower and by how much.
7. If the result shows anomalies or clipping, describe severity using the data.
8. Do not add caveats beyond what the data shows.
9. If confidence is low, mention that the result may be incomplete.
`

const NEARBY_SITES_SYSTEM = `You are a senior solar fleet analyst. The user has requested a list of technically and geographically comparable sites.

You have been given structured similarity scores (v2 algorithm, max 10 points) for up to 5 candidate sites.

For each site explain:
- Why it ranks at its position (which dimensions scored high or low)
- What "${Number(0).toFixed(2)}/10" means in engineering terms (e.g. "close module power match, same microinverter generation, 8 km away")
- Highlight the top 1-2 sites as best engineering peers

CRITICAL RULES:
- NEVER invent site IDs, scores, or distances not in the data.
- Do NOT call any site "best-performing" — the score is technical/geographic similarity only, not performance.
- Use markdown. Keep to 300–500 words.
`

const SITE_ANALYSIS_SYSTEM = `You are a senior solar engineering lead conducting a comprehensive site analysis for a fleet operations team.

You are provided with multi-section analysis data for a specific site. Present a thorough, structured report using the EXACT sections below:

## Site Overview
Location, inverter model, module make/model, wafer type, STC rating, DC/AC ratio, system size (units + MWdc/MWac), irradiance (kWh/m²/day), installation quarter, grid profile (voltage/frequency/phase).

## Comparable Sites
List the peer sites found. For each: site ID, distance (km), similarity score (x.xx / 10), data coverage (%), and a one-line explanation of why it was selected (which scoring dimensions were high or low — geography, module power, microinverter, wafer, irradiance). Highlight the top peer. If none found, say so clearly. NOTE: score reflects technical/geographic similarity — NOT performance.

## Production Analysis
Telemetry coverage period, microinverter count, total energy (kWh/MWh), average daily kWh, median daily kWh, trend (stable/increasing/decreasing/highly_variable/insufficient_data), average AC/DC power, average temperature. Mention the per-microinverter detail (max/median/avg AC power by serial) if available.

## Clipping Analysis
Classification (none/minor/moderate/significant), whether power or current clipping was detected, number of events, affected days, sample dates with start/end hours and duration. Use cautious language: "consistent with", "observed", "suggests".

## Microinverter Environment
Summarize per-microinverter AC voltage, AC frequency, and temperature statistics. Highlight any units showing out-of-range voltage or abnormal temperature.

## RMA / Nearby Grid Quality
Report the number of sites within 10 km and the total nearby RMA requests. Use this as a rough indicator of local grid/quality stress.

## Peer Benchmarking
Target average daily production vs. peer average and median. Deviation percentage (positive = outperforming, negative = underperforming). Confidence level. If no peer telemetry available, state clearly.

## Anomaly Assessment
Alerts and warnings from Z-score analysis. Cite specific serial numbers, z-scores, and energy values vs. site mean.

## Engineering Assessment
As the engineering lead: provide 2-3 specific, actionable observations. Reference actual numbers from the data. Use cautious language: "observed", "consistent with", "worth investigating". Do NOT invent causes.

CRITICAL RULES:
- NEVER invent numbers, serial numbers, or site IDs not in the data.
- If telemetry is unavailable, sections 3–6 should say so and skip to Engineering Assessment.
- If no comparable sites were found, state that in the Comparable Sites section.
- Use markdown headers (##) for every section. Be specific and cite the numbers from the data.
- Token budget: be thorough but not verbose. Target ~600–900 words total.
`

const MICROINVERTER_ANALYSIS_SYSTEM = `You are a senior solar engineering lead reviewing a single microinverter serial number from telemetry data.

Present a thorough, structured report using the EXACT sections below:

## Inverter Identity & Site
Serial number, site ID, location, inverter model, module make/model, STC rating, installation quarter if known.

## Production Summary
Telemetry coverage period, total energy (kWh), number of readings/days, average AC and DC power, and maximum observed temperature.

## AC Power Statistics
Max, median, average, and min AC power. Compare to the STC rating if available; note whether the unit is operating near expected capability.

## AC Voltage, Frequency, Temperature
Report average and range for AC voltage, AC frequency, and temperature. Highlight any concerning deviations (e.g. voltage outside nominal range, high temperature, unstable frequency).

## Daily Production
Average, median, min, and max daily kWh over the telemetry period.

## Clipping Analysis
Classification (none/minor/moderate/significant), total number of clipping events, and specific event dates with start/end hours and duration.

## Engineering Assessment
As the engineering lead: provide 2-3 specific, actionable observations for this microinverter. Reference actual numbers. Use cautious language: "observed", "consistent with", "worth investigating". Do NOT invent causes.

CRITICAL RULES:
- NEVER invent numbers, serial numbers, or site IDs not in the data.
- If telemetry is unavailable, state so clearly and skip the relevant sections.
- Use markdown headers (##) for every section. Be specific and cite the numbers from the data.
- Token budget: be thorough but not verbose. Target ~400–600 words total.
`

const FLEET_SEARCH_SYSTEM = `You are a solar fleet analyst presenting the results of a fleet roster search.

You have been given a list of sites that match specific filtering criteria (microinverter model, module power, country, irradiance level, etc.).

Present the results clearly:
1. State how many sites were found and what filters were applied.
2. Summarise key statistics: most common module make/model, power range, typical irradiance range, geographic spread.
3. List the sites in a concise table or numbered list. For each: site ID, location (city/state/country), inverter model, module (make + model + power), irradiance.
4. If no sites were found, explain which criteria may be too restrictive and suggest relaxing one.

CRITICAL RULES:
- NEVER invent site IDs, model names, or numbers not in the data.
- Do NOT mention performance — this is a roster/configuration search only.
- Use markdown. Keep to 200-400 words.
`

function buildExplainerPrompt(
  question: string,
  request: AnalysisRequest,
  resultSummary: string
): string {
  const confidenceNote = request.confidence === 'low'
    ? '\n[Note: intent confidence was LOW — interpret with caution]'
    : request.confidence === 'medium'
    ? '\n[Note: intent confidence was MEDIUM]'
    : ''

  return `User question: ${question}
${confidenceNote}
Result: ${resultSummary}

${request.intent === 'site_analysis' || request.intent === 'microinverter_analysis' ? 'Provide a comprehensive analysis report with structured sections. Use markdown headers. Be thorough but stick to the data.' : 'Explain the result to the analyst in 2-5 sentences. Do not invent numbers.'}`
}

// ─── Explainer functions ──────────────────────────────────────────────────────

/**
 * Streaming explainer — fires onToken for each token as the LLM streams.
 * Returns the full CompletionResult when done (for latency/token logging).
 */
export async function explainResultStream(
  question: string,
  request: AnalysisRequest,
  result: ToolResult,
  provider: LLMProvider,
  onToken: (token: string) => void
): Promise<CompletionResult> {
  const summary = summarizeResult(result, request)
  const userPrompt = buildExplainerPrompt(question, request, summary)

  const isSiteAnalysis  = request.intent === 'site_analysis'
  const isMicroAnalysis = request.intent === 'microinverter_analysis'
  const isNearby        = request.intent === 'nearby_sites'
  const isFleetSearch   = request.intent === 'fleet_search'
  const systemPrompt = isSiteAnalysis ? SITE_ANALYSIS_SYSTEM
                      : isMicroAnalysis ? MICROINVERTER_ANALYSIS_SYSTEM
                      : isNearby      ? NEARBY_SITES_SYSTEM
                      : isFleetSearch ? FLEET_SEARCH_SYSTEM
                      : EXPLAINER_SYSTEM
  return provider.stream(userPrompt, systemPrompt, onToken, {
    temperature: isSiteAnalysis || isNearby ? 0.4 : 0.3,
    maxTokens: isSiteAnalysis ? 1500 : isMicroAnalysis ? 1200 : isNearby ? 600 : isFleetSearch ? 800 : 300,
    timeoutMs: 60_000,
  })
}

/**
 * Non-streaming explainer — returns the complete narrative at once.
 * Use when the UI does not support streaming.
 */
export async function explainResult(
  question: string,
  request: AnalysisRequest,
  result: ToolResult,
  provider: LLMProvider
): Promise<CompletionResult> {
  const summary = summarizeResult(result, request)
  const userPrompt = buildExplainerPrompt(question, request, summary)

  const isSiteAnalysis  = request.intent === 'site_analysis'
  const isMicroAnalysis = request.intent === 'microinverter_analysis'
  const isNearby        = request.intent === 'nearby_sites'
  const isFleetSearch   = request.intent === 'fleet_search'
  const systemPrompt = isSiteAnalysis ? SITE_ANALYSIS_SYSTEM
                      : isMicroAnalysis ? MICROINVERTER_ANALYSIS_SYSTEM
                      : isNearby      ? NEARBY_SITES_SYSTEM
                      : isFleetSearch ? FLEET_SEARCH_SYSTEM
                      : EXPLAINER_SYSTEM
  return provider.complete(userPrompt, systemPrompt, {
    temperature: isSiteAnalysis || isNearby ? 0.4 : 0.3,
    maxTokens: isSiteAnalysis ? 1500 : isMicroAnalysis ? 1200 : isNearby ? 600 : isFleetSearch ? 800 : 300,
    timeoutMs: isSiteAnalysis || isNearby || isMicroAnalysis ? 90_000 : 30_000,
  })
}

/**
 * Builds a static result summary for cases where Ollama is unavailable
 * and only the tabular result can be shown (no narrative).
 */
export function buildFallbackSummary(result: ToolResult, request: AnalysisRequest): string {
  if (result.rows.length === 0) return 'No data found for this query.'
  return `Found ${result.rows.length} result${result.rows.length !== 1 ? 's' : ''} from ${result.metadata.tool} (${result.metadata.executionMs}ms). Confidence: ${request.confidence}.`
}
