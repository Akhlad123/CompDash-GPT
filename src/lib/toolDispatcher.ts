// Tool dispatcher: maps an AnalysisRequest to a registered analytics tool,
// validates params, executes, and returns the typed ToolResult.
// This is the only place where AnalysisRequest.tool names are resolved to actual functions.

import { TOOL_REGISTRY } from './analyticsTools'
import type { ToolResult } from './analyticsTools'
import type { AnalysisRequest } from './intentRouter'

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
        groupBy:     request.groupBy ?? ['tss_region'],
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
        metric:  request.metric ?? 'energy_produced',
        groupBy: request.groupBy?.[0] ?? 'site_id',
        filters: { siteIds, serials, skuNames, from, to },
        limit:   request.limit ?? 100,
      }
    case 'get_time_series':
      return {
        metric:      request.metric ?? 'energy_produced',
        granularity: 'hour',
        groupBy:     request.groupBy?.[0] ?? 'site_id',
        filters:     { siteIds, serials, skuNames, from, to },
        limit:       request.limit ?? 500,
      }
    case 'compare_telemetry':
      return {
        metric:  request.metric ?? 'energy_produced',
        groupBy: request.groupBy?.[0] ?? 'sku_name',
        filters: { siteIds, serials, skuNames, from, to },
        limit:   request.limit ?? 100,
      }

    // ── Performance tools ─────────────────────────────────────────────────────
    case 'calculate_clipping':
      return {
        siteIds: siteIds.length > 0 ? siteIds : [''],
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
        siteIds:          siteIds.length > 0 ? siteIds : [''],
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
