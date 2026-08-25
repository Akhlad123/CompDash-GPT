import { useQuery } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { FLEET_SITE_LOOKUP } from '@/lib/fleetQueries'
import { useFleetStore } from '@/store/fleetStore'

export interface FleetSiteInfo {
  site_id: string
  country: string | null
  region_bundle: string | null
  tss_region: string | null
  tss_country: string | null
  product_type: string | null
  pv_module_make: string | null
  pv_module_model: string | null
  voc: number | null
  isc: number | null
  module_wafer: string | null
  stc_rating2: number | null
  stc_mwdc: number | null
  mwac: number | null
  dc_ac_ratio: number | null
  unit_count: number | null
  power_bucket: string | null
  power_block: string | null
  quarter_first_interval: string | null
  city: string | null
  state: string | null
  latitude: number | null
  longitude: number | null
  irr_ann_kwh_m2_month: number | null
}

/**
 * Looks up Fleet metadata for a single site_id (the join key between the
 * `fleet` and `telemetry` DuckDB tables). Returns ALL rows for the site
 * (sites can have multiple microinverter types). Only runs once fleet data
 * has been ingested (isFleetLoaded) — callers should pair this with
 * useEnsureFleetData().
 */
export function useSiteFleetInfo(siteId: string | null | undefined) {
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)

  const { data, isLoading, error } = useQuery({
    queryKey: ['fleet-site-lookup', siteId],
    queryFn: () => query<FleetSiteInfo>(FLEET_SITE_LOOKUP(siteId as string)),
    enabled: isFleetLoaded && !!siteId,
    staleTime: Infinity,
  })

  return {
    info: data && data.length > 0 ? data[0] : null,
    allRows: data ?? [],
    isLoading: isFleetLoaded && isLoading,
    notFound: isFleetLoaded && !isLoading && (!data || data.length === 0),
    error,
  }
}
