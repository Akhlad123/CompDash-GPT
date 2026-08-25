// Standalone "find nearby similar sites" tool.
// Answers queries like: "Find nearby sites of 5637519 with IQ9N"
// Uses Fleet data + v2 continuous similarity scoring. Never queries Telemetry.

import { z } from 'zod'
import { query } from '@/lib/duckdb'
import { findSimilarSites, DEFAULT_SIMILARITY_CONFIG } from '@/lib/peerDiscovery'
import type { FleetRow } from '@/lib/peerDiscovery'
import type { AnalyticsTool, ToolResult } from './types'

function escapeSql(s: string): string { return s.replace(/'/g, "''") }

// ─── Parameters ──────────────────────────────────────────────────────────────

const FindNearbyParams = z.object({
  siteId:            z.string().min(1),
  microinverter:     z.string().optional(),
  maxDistanceKm:     z.number().min(1).max(1000).optional(),
  topN:              z.number().int().min(1).max(20).optional(),
  requireModuleInfo: z.boolean().optional(),  // default true — only return peers with module data
})
type FindNearbyParams = z.infer<typeof FindNearbyParams>

// ─── Fleet queries ────────────────────────────────────────────────────────────

async function getTargetSite(siteId: string): Promise<FleetRow | null> {
  const rows = await query<FleetRow>(`
    SELECT site_id, latitude, longitude, pv_module_model, stc_rating2,
           module_wafer, product_type, model_name, unit_count, dc_ac_ratio,
           country, tss_region, city, state, quarter_first_interval, pv_module_make,
           irr_ann_kwh_m2_month
    FROM fleet
    WHERE site_id = '${escapeSql(siteId)}'
    LIMIT 1
  `.trim())
  return rows[0] ?? null
}

async function getFleetRoster(excludeSiteId: string): Promise<FleetRow[]> {
  return query<FleetRow>(`
    SELECT site_id, latitude, longitude, pv_module_model, stc_rating2,
           module_wafer, product_type, model_name, unit_count, dc_ac_ratio,
           country, tss_region, city, state, quarter_first_interval, pv_module_make,
           irr_ann_kwh_m2_month
    FROM fleet
    WHERE site_id != '${escapeSql(excludeSiteId)}'
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    LIMIT 8000
  `.trim())
}

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeFindNearby(params: FindNearbyParams): Promise<ToolResult> {
  const started = Date.now()
  const { siteId, microinverter, maxDistanceKm, topN } = params

  const target = await getTargetSite(siteId)
  if (!target) {
    return {
      rows: [],
      metadata: {
        tool: 'find_nearby_sites',
        params: params as unknown as Record<string, unknown>,
        sql: `-- Site ${siteId} not found in Fleet`,
        executionMs: Date.now() - started,
        rowCount: 0,
        warning: `Site ${siteId} was not found in Fleet data.`,
      },
    }
  }

  const roster = await getFleetRoster(siteId)

  const cfg = {
    ...DEFAULT_SIMILARITY_CONFIG,
    geography: {
      ...DEFAULT_SIMILARITY_CONFIG.geography,
      maxDistanceKm: maxDistanceKm ?? DEFAULT_SIMILARITY_CONFIG.geography.maxDistanceKm,
    },
    topN: topN ?? DEFAULT_SIMILARITY_CONFIG.topN,
    requireModuleInfo: params.requireModuleInfo !== false,  // default true
  }

  const peers = findSimilarSites(target, roster, cfg, microinverter)

  const targetLocation = [target.city, target.state, target.country].filter(Boolean).join(', ')

  const rows = peers.map((p) => ({
    _result_type: 'nearby_sites',
    site_id: p.site_id,
    distance_km: p.distance_km,
    total_score: p.total_score,
    coverage_pct: p.coverage,
    score_geography: p.scores.geography,
    score_module_power: p.scores.module_power,
    score_microinverter: p.scores.microinverter,
    score_wafer: p.scores.wafer,
    score_irradiance: p.scores.irradiance,
    location: p.location,
    model_name: p.model_name,
    product_type: p.product_type,
    stc_rating2: p.stc_rating2,
    module_wafer: p.module_wafer,
    pv_module_model: p.pv_module_model,
    pv_module_make: p.pv_module_make,
    has_module_info: p.has_module_info,
    irr_ann_kwh_m2_month: p.irr_ann_kwh_m2_month,
    unit_count: p.unit_count,
  }))

  return {
    rows,
    metadata: {
      tool: 'find_nearby_sites',
      params: params as unknown as Record<string, unknown>,
      sql: `-- Fleet-only peer discovery: target=${siteId} (${targetLocation}), maxDist=${cfg.geography.maxDistanceKm}km, filter=${microinverter ?? 'none'}, candidates=${roster.length}, results=${peers.length}`,
      executionMs: Date.now() - started,
      rowCount: rows.length,
      warning: rows.length === 0
        ? `No comparable sites found within ${cfg.geography.maxDistanceKm} km${microinverter ? ` with microinverter matching "${microinverter}"` : ''}.`
        : undefined,
    },
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const findNearbyTool: AnalyticsTool<FindNearbyParams> = {
  name: 'find_nearby_sites',
  description: 'Find comparable nearby sites for a target site using the v2 continuous 10-point similarity algorithm (Geography 3pts + Module Power 2pts + Microinverter 2.5pts + Wafer 2pts + Irradiance 0.5pts). Optional microinverter filter. Use for "nearby sites of X", "similar sites to X", "peer sites for X with IQ9N", "find comparable sites near X".',
  parametersSchema: FindNearbyParams,
  execute: executeFindNearby,
}
