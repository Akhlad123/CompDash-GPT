import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import ExportToolbar from '@/components/export/ExportToolbar'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter, FLEET_CHART_BLOCK_DATA, FLEET_CHART_REGION_STATS,
  FLEET_DISTINCT_QUARTERS, FLEET_DISTINCT_TSS_REGIONS, FLEET_DISTINCT_TSS_COUNTRIES,
} from '@/lib/fleetQueries'
import {
  TSS_REGION_ORDER, TSS_REGION_POWER_BINS,
  WAFER_ORDER, WAFER_COLORS, BIN_POSITION_COLORS,
  tssRegionLabel, buildPowerBucketCaseSql,
} from '@/lib/fleetRegions'

interface BlockRow {
  tss_region: string
  power_block: string
  module_wafer: string
  product_type: string
  units: number
}

interface RegionStatsRow {
  tss_region: string
  sites_with: number
  sites_without: number
  units_with: number
  units_without: number
  avg_power_w: number | null
  avg_dc_ac: number | null
  mw_dc: number | null
  median_stc: number | null
  p75_stc: number | null
}

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

/** Top-2 product types by units within a group, formatted like "IQ8HC (45%)  IQ8P (30%)". */
function topMicro(rows: BlockRow[]): string {
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.product_type, (totals.get(r.product_type) ?? 0) + safe(r.units))
  const total = Array.from(totals.values()).reduce((a, b) => a + b, 0)
  if (total === 0) return ''
  const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2)
  return sorted.map(([name, cnt]) => `${name} (${((cnt / total) * 100).toFixed(0)}%)`).join('  ·  ')
}

/**
 * Build a composite SQL CASE expression that applies the correct power-bin
 * thresholds for *each* tss_region, all in one CASE. This lets us query all
 * regions in a single SQL statement while respecting per-region bin ranges.
 */
function buildPerRegionPowerBlockExpr(regions: readonly string[]): string {
  const parts = regions
    .filter((code) => TSS_REGION_POWER_BINS[code])
    .map((code) => {
      const inner = buildPowerBucketCaseSql(TSS_REGION_POWER_BINS[code])
      return `WHEN tss_region = '${code}' THEN ${inner}`
    })
  return `CASE ${parts.join(' ')} ELSE NULL END`
}

export default function FleetChartReplicaPage() {
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)
  const selectedQuarters = useFleetStore((s) => s.selectedQuarters)
  const setSelectedQuarters = useFleetStore((s) => s.setSelectedQuarters)
  const selectedTssRegions = useFleetStore((s) => s.selectedTssRegions)
  const setSelectedTssRegions = useFleetStore((s) => s.setSelectedTssRegions)
  const selectedTssCountries = useFleetStore((s) => s.selectedTssCountries)
  const setSelectedTssCountries = useFleetStore((s) => s.setSelectedTssCountries)

  const { data: quarters } = useQuery({
    queryKey: ['fleet-quarters'],
    queryFn: () => query<{ quarter: string }>(FLEET_DISTINCT_QUARTERS),
    enabled: isFleetLoaded,
  })
  const { data: tssRegions } = useQuery({
    queryKey: ['fleet-tss-regions'],
    queryFn: () => query<{ tss_region: string }>(FLEET_DISTINCT_TSS_REGIONS),
    enabled: isFleetLoaded,
  })
  const { data: tssCountries } = useQuery({
    queryKey: ['fleet-tss-countries', selectedTssRegions],
    queryFn: () => query<{ tss_country: string }>(FLEET_DISTINCT_TSS_COUNTRIES(selectedTssRegions)),
    enabled: isFleetLoaded,
  })

  const where = buildFleetFilter({
    quarters: selectedQuarters,
    tssRegions: selectedTssRegions,
    tssCountries: selectedTssCountries,
  })

  const powerBlockExpr = buildPerRegionPowerBlockExpr(TSS_REGION_ORDER)

  const { data: blockRows, isLoading: blockLoading, error: blockError } = useQuery({
    queryKey: ['fleet-chart-block-data', where],
    queryFn: () => query<BlockRow>(FLEET_CHART_BLOCK_DATA(where, [...WAFER_ORDER], powerBlockExpr)),
    enabled: isFleetLoaded,
  })

  const { data: regionStats } = useQuery({
    queryKey: ['fleet-chart-region-stats', where],
    queryFn: () => query<RegionStatsRow>(FLEET_CHART_REGION_STATS(where)),
    enabled: isFleetLoaded,
  })

  // Determine which regions to show (all if none selected, respecting data)
  const regionsToShow = useMemo(() => {
    if (selectedTssRegions.length > 0) return selectedTssRegions
    // Use the canonical order but only regions that actually exist in the data
    const dataRegions = new Set((tssRegions ?? []).map((r) => r.tss_region))
    return TSS_REGION_ORDER.filter((code) => dataRegions.has(code))
  }, [selectedTssRegions, tssRegions])

  const perRegion = useMemo(() => {
    if (!blockRows) return []
    return regionsToShow
      .map((regionCode) => {
        const rows = blockRows.filter((r) => r.tss_region === regionCode)
        if (rows.length === 0) return null
        const binDef = TSS_REGION_POWER_BINS[regionCode]
        if (!binDef) return null
        const regionTotal = rows.reduce((s, r) => s + safe(r.units), 0)

        const buckets = binDef.labels.map((label) => {
          const bucketRows = rows.filter((r) => r.power_block === label)
          const blockTotal = bucketRows.reduce((s, r) => s + safe(r.units), 0)
          const blockPct = regionTotal > 0 ? (blockTotal / regionTotal) * 100 : 0
          const wafers = WAFER_ORDER.map((wafer) => {
            const waferRows = bucketRows.filter((r) => r.module_wafer === wafer)
            const count = waferRows.reduce((s, r) => s + safe(r.units), 0)
            const pct = blockTotal > 0 ? (count / blockTotal) * 100 : 0
            return { wafer, count, pct, micro: count > 0 ? topMicro(waferRows) : '' }
          })
          return { label, blockTotal, blockPct, wafers }
        }).filter((b) => b.blockTotal > 0)

        const stats = regionStats?.find((r) => r.tss_region === regionCode)
        return { regionCode, regionTotal, buckets, stats }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
  }, [blockRows, regionsToShow, regionStats])

  if (fleetError) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">Failed to load fleet data</p>
          <p className="mt-1 text-sm">{fleetError instanceof Error ? fleetError.message : String(fleetError)}</p>
        </div>
      </div>
    )
  }

  if (fleetLoading || !isFleetLoaded) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading fleet dataset…
      </div>
    )
  }

  const regionSelectionLabel = selectedTssRegions.length > 0
    ? selectedTssRegions.map(tssRegionLabel).join(', ')
    : 'All Regions'
  const countrySelectionLabel = selectedTssCountries.length > 0
    ? selectedTssCountries.join(', ')
    : 'All Countries'
  const quarterSelectionLabel = selectedQuarters.length > 0 ? selectedQuarters.join(', ') : 'All Quarters'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Summary Chart</h1>
          <p className="text-sm text-muted-foreground">
            Module wafer share with top paired microinverters — mirrors the offline analytics chart.
          </p>
          <p className="mt-1 text-xs font-medium text-foreground/80">
            Showing: {regionSelectionLabel} · {countrySelectionLabel} · {quarterSelectionLabel}
          </p>
        </div>
        <ExportToolbar elementId="chart-replica-content" filename="summary-chart" />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-6 pt-4 pb-4">
          <MultiSelectDropdown
            label="Quarter"
            options={(quarters ?? []).map((q) => q.quarter)}
            selected={selectedQuarters}
            onChange={setSelectedQuarters}
          />
          <MultiSelectDropdown
            label="Region"
            options={(tssRegions ?? []).map((r) => r.tss_region)}
            selected={selectedTssRegions}
            onChange={setSelectedTssRegions}
            formatLabel={tssRegionLabel}
          />
          <MultiSelectDropdown
            label="Country"
            options={(tssCountries ?? []).map((c) => c.tss_country)}
            selected={selectedTssCountries}
            onChange={setSelectedTssCountries}
          />
        </CardContent>
      </Card>

      <div id="chart-replica-content" className="space-y-6">
        {blockLoading ? (
          <div className="flex items-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : blockError ? (
          <div className="flex items-center gap-2 py-8 text-red-600">
            <AlertTriangle className="h-4 w-4" /> {String(blockError)}
          </div>
        ) : perRegion.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-muted-foreground">
            <AlertTriangle className="h-4 w-4" /> No data matches the current filters.
          </div>
        ) : (
          perRegion.map(({ regionCode, buckets, stats }) => (
            <Card key={regionCode}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {tssRegionLabel(regionCode)}
                    {selectedTssCountries.length > 0 && (
                      <span className="ml-2 text-sm font-normal text-blue-600">
                        — Selected Country: {selectedTssCountries.join(', ')}
                      </span>
                    )}
                  </span>
                  {stats && (
                    <span className="text-xs font-normal text-muted-foreground">
                      With Module data: {safe(stats.sites_with).toLocaleString()} sites /{' '}
                      {safe(stats.units_with).toLocaleString()} units ·{' '}
                      <span className="text-amber-600">
                        Without Module data: {safe(stats.sites_without).toLocaleString()} sites /{' '}
                        {safe(stats.units_without).toLocaleString()} units
                      </span>{' '}
                      · Avg: {safe(stats.avg_power_w).toFixed(0)}W · Median: {safe(stats.median_stc).toFixed(0)}W ·{' '}
                      P75: {safe(stats.p75_stc).toFixed(0)}W · Avg DC/AC: {safe(stats.avg_dc_ac).toFixed(2)} · MWdc:{' '}
                      {safe(stats.mw_dc).toFixed(1)}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2 overflow-x-auto">
                  {buckets.map((bucket, bi) => (
                    <div
                      key={bucket.label}
                      className="min-w-[180px] flex-1 rounded-lg border p-3"
                      style={{ backgroundColor: BIN_POSITION_COLORS[bi % BIN_POSITION_COLORS.length] }}
                    >
                      <div className="mb-2 text-center">
                        <p className="text-sm font-bold text-slate-800">{bucket.label}</p>
                        <p className="text-xs text-slate-600">{bucket.blockPct.toFixed(1)}% of region</p>
                      </div>
                      <div className="space-y-2">
                        {bucket.wafers.filter((w) => w.count > 0).map((w) => (
                          <div key={w.wafer}>
                            <div className="flex items-center justify-between text-xs font-semibold" style={{ color: WAFER_COLORS[w.wafer] }}>
                              <span>{w.wafer}</span>
                              <span>{w.pct.toFixed(1)}%</span>
                            </div>
                            <div className="mt-0.5 h-1.5 w-full rounded-full bg-white/60">
                              <div
                                className="h-1.5 rounded-full"
                                style={{ width: `${w.pct}%`, backgroundColor: WAFER_COLORS[w.wafer] }}
                              />
                            </div>
                            {w.micro && (
                              <p className="mt-0.5 truncate text-[10px] text-slate-600" title={w.micro}>
                                {w.micro}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
