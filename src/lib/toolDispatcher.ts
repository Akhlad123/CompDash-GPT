// Tool dispatcher: maps an AnalysisRequest to a registered analytics tool,
// validates params, executes, and returns the typed ToolResult.
// This is the only place where AnalysisRequest.tool names are resolved to actual functions.

import { TOOL_REGISTRY } from './analyticsTools'
import type { ToolResult } from './analyticsTools'
import type { AnalysisRequest } from './intentRouter'

// Safety-net alias map for telemetry metrics — catches anything the intent router missed
const TELEMETRY_METRIC_SAFE: Record<string, string> = {
  voltage: 'dc_voltage', vmp: 'dc_voltage', v_mp: 'dc_voltage', vdc: 'dc_voltage',
  panel_voltage: 'dc_voltage', module_voltage: 'dc_voltage', string_voltage: 'dc_voltage',
  mppt_voltage: 'dc_voltage',
  current: 'dc_current', imp: 'dc_current', i_mp: 'dc_current', idc: 'dc_current',
  panel_current: 'dc_current',
  power: 'dc_power', dc: 'dc_power', watt: 'dc_power', watts: 'dc_power',
  ac: 'ac_power', ac_watt: 'ac_power', output_power: 'ac_power',
  vac: 'ac_voltage', grid_voltage: 'ac_voltage', line_voltage: 'ac_voltage',
  frequency: 'ac_frequency', freq: 'ac_frequency', hz: 'ac_frequency',
  grid_frequency: 'ac_frequency',
  temperature: 'temperature_c', temp: 'temperature_c', temp_c: 'temperature_c',
  celsius: 'temperature_c', temp_f: 'temperature_f', fahrenheit: 'temperature_f',
  energy: 'energy_produced', production: 'energy_produced', yield: 'energy_produced',
  kwh: 'energy_produced', wh: 'energy_produced',
}

const VALID_TELEMETRY_METRICS = new Set([
  'energy_produced', 'dc_power', 'ac_power', 'temperature_c', 'temperature_f',
  'dc_current', 'dc_voltage', 'ac_voltage', 'ac_frequency', 'duration',
])

function safeTelemetryMetric(raw: string | undefined): string {
  if (!raw) return 'energy_produced'
  const lower = raw.toLowerCase().trim()
  if (VALID_TELEMETRY_METRICS.has(lower)) return lower
  return TELEMETRY_METRIC_SAFE[lower] ?? 'dc_voltage'
}

// Safety-net for telemetry groupBy — LLM often returns "day", "inverter", etc.
const TELEMETRY_GROUPBY_SAFE: Record<string, string> = {
  site: 'site_id', site_id: 'site_id', sites: 'site_id',
  serial: 'serial_number', serial_number: 'serial_number',
  inverter: 'serial_number', inverters: 'serial_number', microinverter: 'serial_number',
  sku: 'sku_name', sku_name: 'sku_name', product: 'sku_name', model: 'sku_name',
  none: 'none', total: 'none', all: 'none', overall: 'none',
  // time-based terms → none (time bucketing is handled by granularity in time_series)
  day: 'none', daily: 'none', date: 'none', hour: 'none', hourly: 'none',
  week: 'none', weekly: 'none', month: 'none', monthly: 'none', time: 'none',
}

function safeTelemetryGroupBy(raw: string | undefined, allowNone = true): string {
  if (!raw) return 'site_id'
  const lower = raw.toLowerCase().trim()
  const mapped = TELEMETRY_GROUPBY_SAFE[lower]
  if (mapped) return (!allowNone && mapped === 'none') ? 'site_id' : mapped
  return 'site_id'
}

// Safety-net for fleet groupBy — LLM often returns "region" instead of "tss_region"
const FLEET_GROUPBY_SAFE: Record<string, string> = {
  region: 'tss_region', tss_region: 'tss_region', regions: 'tss_region',
  country: 'country', countries: 'country', tss_country: 'tss_country',
  product: 'product_type', product_type: 'product_type', model: 'product_type',
  sku: 'product_type', inverter: 'product_type',
  quarter: 'quarter_first_interval', quarter_first_interval: 'quarter_first_interval',
  quarter_created: 'quarter_device_created', quarter_device_created: 'quarter_device_created',
  city: 'city', state: 'state',
  wafer: 'module_wafer', module_wafer: 'module_wafer',
  power_bucket: 'power_bucket', power_block: 'power_block',
  pv_module_make: 'pv_module_make', pv_module_model: 'pv_module_model',
  device_type_name: 'device_type_name', region_bundle: 'region_bundle',
}

const VALID_FLEET_DIMS = new Set([
  'country', 'tss_region', 'tss_country', 'region_bundle',
  'product_type', 'module_wafer', 'power_bucket', 'power_block',
  'quarter_first_interval', 'quarter_device_created', 'city', 'state',
  'pv_module_make', 'pv_module_model', 'device_type_name',
])

function safeFleetGroupBy(raw: string[] | undefined): string[] {
  if (!raw?.length) return ['tss_region']
  return raw.map((g) => {
    const lower = g.toLowerCase().trim()
    if (VALID_FLEET_DIMS.has(lower)) return lower
    return FLEET_GROUPBY_SAFE[lower] ?? 'tss_region'
  })
}

// Safety-net for time series granularity
const GRANULARITY_SAFE: Record<string, string> = {
  '5min': '5min', '15min': '15min', hour: 'hour', day: 'day', week: 'week', month: 'month',
  hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month',
  '1h': 'hour', '1d': 'day', '1w': 'week', '1m': 'month',
  minute: '5min', minutes: '5min',
}

function safeGranularity(raw: string | undefined): string {
  if (!raw) return 'hour'
  return GRANULARITY_SAFE[raw.toLowerCase().trim()] ?? 'hour'
}

export class ToolNotFoundError extends Error {
  readonly toolName: string
  constructor(toolName: string) {
    super(`No analytics tool registered for name: "${toolName}"`)
    this.name = 'ToolNotFoundError'
    this.toolName = toolName
  }
}

export class ToolParamError extends Error {
  readonly toolName: string
  readonly validationMessage: string
  constructor(toolName: string, validationMessage: string) {
    super(`Invalid params for tool "${toolName}": ${validationMessage}`)
    this.name = 'ToolParamError'
    this.toolName = toolName
    this.validationMessage = validationMessage
  }
}

/**
 * Builds tool-specific params from a validated AnalysisRequest.
 * Bridges the generic AnalysisRequest fields to each tool's specific Zod schema.
 */
function buildToolParams(request: AnalysisRequest): Record<string, unknown> {
  const f = (request.filters ?? {}) as Record<string, unknown>
  const siteIds  = Array.isArray(f['siteIds'])  ? (f['siteIds']  as string[]) : request.sites  ?? []
  const serials  = Array.isArray(f['serials'])  ? (f['serials']  as string[]) : request.serials ?? []
  const skuNames = Array.isArray(f['skuNames']) ? (f['skuNames'] as string[]) : request.products ?? []
  const tssRegions   = Array.isArray(f['tssRegions'])   ? f['tssRegions']   as string[] : undefined
  const quarters     = Array.isArray(f['quarters'])     ? f['quarters']     as string[] : undefined
  const countries    = Array.isArray(f['countries'])    ? f['countries']    as string[] : undefined
  const tssCountries = Array.isArray(f['tssCountries']) ? f['tssCountries'] as string[] : undefined
  const from = request.timeRange?.from ?? (typeof f['from'] === 'string' ? f['from'] : undefined)
  const to   = request.timeRange?.to   ?? (typeof f['to']   === 'string' ? f['to']   : undefined)

  const fleetFilters = { quarters, tssRegions, tssCountries, countries }

  switch (request.tool) {
    // ── Fleet tools ──────────────────────────────────────────────────────────
    case 'get_fleet_summary':
      return {
        metric:      request.metric ?? 'unit_count',
        aggregation: request.aggregation ?? 'sum',
        groupBy:     safeFleetGroupBy(request.groupBy),
        filters:     { ...fleetFilters, ...(skuNames.length > 0 ? { skuNames } : {}) },
        limit:       request.limit ?? 50,
      }
    case 'get_site_summary':
      return { siteId: siteIds[0] ?? '' }

    case 'get_product_summary':
      return {
        groupBy:     request.groupBy ?? ['product_type'],
        filters:     fleetFilters,
        includeWafer: true,
        limit:       request.limit ?? 100,
      }
    case 'get_region_summary':
      return { filters: fleetFilters, mode: 'units' }

    case 'get_dc_ac_ratio':
      return {
        groupBy:     request.groupBy ?? ['tss_region'],
        filters:     fleetFilters,
        aggregation: request.aggregation ?? 'avg',
        limit:       request.limit ?? 50,
      }

    // ── Energy tools ─────────────────────────────────────────────────────────
    case 'calculate_energy':
      return {
        groupBy: request.groupBy?.[0] ?? 'site_id',
        filters: { siteIds, serials, skuNames, from, to },
        unit:    'kWh',
        limit:   request.limit ?? 100,
      }
    case 'compare_energy': {
      const [prodA, prodB] = (request.products ?? []).slice(0, 2)
      const [siteA, siteB] = (siteIds).slice(0, 2)
      return {
        groupA: { label: prodA ?? siteA ?? 'GroupA', skuNames: prodA ? [prodA] : undefined, siteIds: siteA && !prodA ? [siteA] : undefined },
        groupB: { label: prodB ?? siteB ?? 'GroupB', skuNames: prodB ? [prodB] : undefined, siteIds: siteB && !prodB ? [siteB] : undefined },
        groupBy: request.groupBy?.[0] === 'site_id' ? 'site_id' : 'total',
        from,
        to,
        unit: 'kWh',
      }
    }
    case 'calculate_energy_per_inverter':
      return {
        siteIds: siteIds.length > 0 ? siteIds : undefined,
        from,
        to,
        topN: request.limit ?? 50,
        orderBy: 'desc',
      }

    // ── Telemetry tools ───────────────────────────────────────────────────────
    case 'get_telemetry_statistics':
      return {
        metric:  safeTelemetryMetric(request.metric),
        groupBy: safeTelemetryGroupBy(request.groupBy?.[0]),
        filters: { siteIds, serials, skuNames, from, to },
        limit:   request.limit ?? 100,
      }
    case 'get_time_series': {
      // LLM may put time terms ("day", "daily") in groupBy — route them to granularity
      const TIME_TERMS = new Set(['day', 'daily', 'hour', 'hourly', 'week', 'weekly', 'month', 'monthly', '5min', '15min', '1h', '1d', '1w', '1m', 'minute', 'minutes'])
      const gArr = request.groupBy ?? []
      let tsGranularity = 'day'
      let tsGroupBy = 'none'
      for (const g of gArr) {
        const lower = g.toLowerCase().trim()
        if (TIME_TERMS.has(lower)) {
          tsGranularity = lower
        } else {
          tsGroupBy = lower
        }
      }
      return {
        metric:      safeTelemetryMetric(request.metric),
        granularity: safeGranularity(tsGranularity),
        groupBy:     safeTelemetryGroupBy(tsGroupBy === 'none' ? undefined : tsGroupBy, true),
        filters:     { siteIds, serials, skuNames, from, to },
        limit:       request.limit ?? 500,
      }
    }
    case 'compare_telemetry': {
      const cmpGroup = safeTelemetryGroupBy(request.groupBy?.[0] ?? 'sku_name', false)
      return {
        metric:  safeTelemetryMetric(request.metric),
        groupBy: cmpGroup === 'none' ? 'sku_name' : cmpGroup,
        filters: { siteIds, serials, skuNames, from, to },
        limit:   request.limit ?? 100,
      }
    }

    // ── Performance tools ─────────────────────────────────────────────────────
    case 'calculate_clipping':
      return {
        siteIds: siteIds.filter(Boolean),
        from,
        to,
        isFrance:            false,
        minConsecutiveHours: 2,
        topN:                request.limit ?? 100,
      }
    case 'calculate_inverter_utilization':
      return {
        siteIds:   siteIds.length > 0 ? siteIds : undefined,
        serials:   serials.length > 0 ? serials : undefined,
        from,
        to,
        groupBy:   request.groupBy?.[0] ?? 'sku_name',
        threshold: 0.9,
        limit:     request.limit ?? 100,
      }
    case 'detect_anomalies':
      return {
        siteIds:          siteIds.filter(Boolean),
        from,
        to,
        alertThreshold:   2.0,
        warningThreshold: 1.5,
        topN:             request.limit ?? 50,
      }
    case 'get_inverter_drilldown':
      return {
        serialNumber: serials[0] ?? '',
        from,
        to,
      }

    // ── Site analysis workflow ───────────────────────────────────────────────
    case 'analyze_site':
      return {
        siteId: siteIds[0] ?? '',
        from,
        to,
        requireModuleInfo: request.requireModuleInfo,
      }
    case 'analyze_microinverter':
      return {
        serialNumber: serials[0] ?? '',
        from,
        to,
      }

    // ── Nearby similar sites ─────────────────────────────────────────────────
    case 'find_nearby_sites':
      return {
        siteId:            siteIds[0] ?? '',
        microinverter:     (request.products ?? [])[0] ?? undefined,
        maxDistanceKm:     typeof request.limit === 'number' && request.limit <= 1000 ? request.limit : undefined,
        topN:              5,
        requireModuleInfo: request.requireModuleInfo,
      }

    // ── Fleet roster search ───────────────────────────────────────────────────
    case 'fleet_search': {
      // microinverter: from filters.microinverter or products[0]
      const micro = typeof f['microinverter'] === 'string'
        ? f['microinverter']
        : (request.products ?? [])[0] ?? undefined
      // country: from filters.country or filters.countries[0]
      const country = typeof f['country'] === 'string'
        ? f['country']
        : (Array.isArray(f['countries']) ? (f['countries'] as string[])[0] : undefined)
          ?? (Array.isArray(countries) ? countries[0] : undefined)
      return {
        microinverter: micro,
        minPowerW:     typeof f['minPowerW']   === 'number' ? f['minPowerW']   : undefined,
        maxPowerW:     typeof f['maxPowerW']   === 'number' ? f['maxPowerW']   : undefined,
        country,
        state:         typeof f['state']       === 'string' ? f['state']       : undefined,
        irradiance:    typeof f['irradiance']  === 'string' ? f['irradiance']  : undefined,
        moduleWafer:   typeof f['moduleWafer'] === 'string' ? f['moduleWafer'] : undefined,
        moduleMake:    typeof f['moduleMake']  === 'string' ? f['moduleMake']  : undefined,
        topN:          typeof request.limit === 'number' ? request.limit
                       : typeof f['topN'] === 'number' ? f['topN']
                       : 10,
      }
    }

    // ── System Expansion / Lotto ───────────────────────────────────────────
    case 'get_system_expansion': {
      // LLM may signal mode via groupBy or we infer from context
      const modeHint = (request.groupBy?.[0] ?? '').toLowerCase()
      const mode = (['summary', 'details', 'trend'] as const).includes(modeHint as 'summary' | 'details' | 'trend')
        ? modeHint as 'summary' | 'details' | 'trend'
        : 'summary'
      return {
        mode,
        filters: { ...fleetFilters, ...(countries ? { countries } : {}) },
        limit:   request.limit ?? 50,
      }
    }

    default:
      return {}
  }
}

/**
 * Dispatches an AnalysisRequest to the matching registered tool.
 * Validates params via the tool's Zod schema before execution.
 */
export async function dispatchTool(request: AnalysisRequest): Promise<ToolResult> {
  if (request.intent === 'unanswerable' || !request.tool) {
    return {
      rows: [],
      metadata: {
        tool: 'unanswerable',
        params: {},
        executionMs: 0,
        rowCount: 0,
        warning: request.caveat ?? 'This question cannot be answered from available data.',
      },
    }
  }

  const tool = TOOL_REGISTRY.get(request.tool)
  if (!tool) throw new ToolNotFoundError(request.tool)

  const rawParams = buildToolParams(request)
  const parseResult = tool.parametersSchema.safeParse(rawParams)
  if (!parseResult.success) {
    throw new ToolParamError(request.tool, parseResult.error.message)
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return tool.execute(parseResult.data)
}
