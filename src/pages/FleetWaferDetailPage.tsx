import { useMemo, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertTriangle, RotateCcw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import BarChart from '@/components/charts/BarChart'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import PowerBucketEditor from '@/components/fleet/PowerBucketEditor'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter, FLEET_WAFER_DETAIL_BY_TSS_REGION, FLEET_DISTINCT_TSS_REGIONS,
  FLEET_DISTINCT_QUARTERS,
} from '@/lib/fleetQueries'
import { WAFER_ORDER, WAFER_COLORS, TSS_REGION_POWER_BINS, buildPowerBucketCaseSql, tssRegionLabel } from '@/lib/fleetRegions'
import type { EChartsOption } from 'echarts'

interface WaferDetailRow {
  module_wafer: string
  power_block: string
  units: number
}

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

export default function FleetWaferDetailPage() {
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)
  const selectedQuarters = useFleetStore((s) => s.selectedQuarters)
  const setSelectedQuarters = useFleetStore((s) => s.setSelectedQuarters)
  const aggMode = useFleetStore((s) => s.aggMode)
  const setAggMode = useFleetStore((s) => s.setAggMode)
  const customWaferBins = useFleetStore((s) => s.customWaferBins)
  const setWaferBinsForRegion = useFleetStore((s) => s.setWaferBinsForRegion)
  const resetWaferBinsForRegion = useFleetStore((s) => s.resetWaferBinsForRegion)

  const [searchParams, setSearchParams] = useSearchParams()
  const [region, setRegion] = useState<string>(searchParams.get('region') ?? '')

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

  useEffect(() => {
    if (!region && tssRegions && tssRegions.length > 0) {
      setRegion(tssRegions[0].tss_region)
    }
  }, [region, tssRegions])

  const handleSelectRegion = (r: string) => {
    setRegion(r)
    setSearchParams({ region: r })
  }

  const where = buildFleetFilter({ quarters: selectedQuarters })
  const unitLabel = aggMode === 'sites' ? 'Sites' : 'Units'

  const defaultBins = region ? TSS_REGION_POWER_BINS[region] : undefined
  const effectiveBins = (region && customWaferBins[region]) || defaultBins
  const powerBlockExpr = region && customWaferBins[region]
    ? buildPowerBucketCaseSql(customWaferBins[region])
    : (defaultBins ? buildPowerBucketCaseSql(defaultBins) : 'power_block')

  const { data: detail, isLoading: detailLoading, error: detailError } = useQuery({
    queryKey: ['fleet-wafer-detail', region, where, aggMode, powerBlockExpr],
    queryFn: () => query<WaferDetailRow>(FLEET_WAFER_DETAIL_BY_TSS_REGION(region, where, aggMode, powerBlockExpr)),
    enabled: isFleetLoaded && !!region,
  })

  const powerBlockLabels = effectiveBins ? effectiveBins.labels : []

  /** Total (units or sites) per power-bucket, across all wafers — denominator for % share. */
  const bucketTotals = useMemo(() => {
    const map = new Map<string, number>()
    if (!detail) return map
    for (const label of powerBlockLabels) {
      const total = detail
        .filter((r) => r.power_block === label)
        .reduce((sum, r) => sum + safe(r.units), 0)
      map.set(label, total)
    }
    return map
  }, [detail, powerBlockLabels])

  const chartOption = useMemo<EChartsOption>(() => {
    if (!detail || detail.length === 0 || powerBlockLabels.length === 0) return {}
    const series = WAFER_ORDER.map((wafer) => ({
      name: wafer,
      type: 'bar' as const,
      stack: 'wafer',
      color: WAFER_COLORS[wafer],
      data: powerBlockLabels.map((label) => {
        const row = detail.find((r) => r.module_wafer === wafer && r.power_block === label)
        return row ? safe(row.units) : 0
      }),
    }))
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          const items = Array.isArray(params) ? params : [params]
          if (items.length === 0) return ''
          const first = items[0] as unknown as { axisValue?: string; name?: string }
          const label = String(first.axisValue ?? first.name ?? '')
          const bucketTotal = bucketTotals.get(label) ?? 0
          const lines = items
            .filter((it) => Number(it.value) > 0)
            .map((it) => {
              const val = Number(it.value)
              const pct = bucketTotal > 0 ? ((val / bucketTotal) * 100).toFixed(1) : '0.0'
              return `${it.marker ?? ''} ${it.seriesName}: ${val.toLocaleString()} ${unitLabel.toLowerCase()} (${pct}%)`
            })
          return [`<b>${label}</b> — Total: ${bucketTotal.toLocaleString()} ${unitLabel.toLowerCase()}`, ...lines].join('<br/>')
        },
      },
      legend: { top: 0 },
      grid: { left: 60, right: 20, top: 40, bottom: 60 },
      xAxis: { type: 'category', data: powerBlockLabels, axisLabel: { fontSize: 11 } },
      yAxis: { type: 'value', name: unitLabel },
      series,
    }
  }, [detail, powerBlockLabels, bucketTotals, unitLabel])

  const totalsByWafer = useMemo(() => {
    if (!detail) return new Map<string, number>()
    const map = new Map<string, number>()
    for (const row of detail) {
      map.set(row.module_wafer, (map.get(row.module_wafer) ?? 0) + safe(row.units))
    }
    return map
  }, [detail])

  const grandTotal = useMemo(
    () => Array.from(totalsByWafer.values()).reduce((a, b) => a + b, 0),
    [totalsByWafer]
  )

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Wafer Detail</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Aggregate by:</span>
          <Tabs value={aggMode} onValueChange={(v) => setAggMode(v as 'units' | 'sites')}>
            <TabsList>
              <TabsTrigger value="units">Units</TabsTrigger>
              <TabsTrigger value="sites">Sites</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
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
          <div>
            <div className="mb-1.5 text-sm font-medium">Region:</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(tssRegions ?? []).map((r) => (
                <Badge
                  key={r.tss_region}
                  variant={region === r.tss_region ? 'default' : 'secondary'}
                  className="cursor-pointer select-none"
                  onClick={() => handleSelectRegion(r.tss_region)}
                >
                  {tssRegionLabel(r.tss_region)}
                </Badge>
              ))}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {defaultBins && (
              <PowerBucketEditor
                value={effectiveBins ?? defaultBins}
                defaultValue={defaultBins}
                onSave={(def) => setWaferBinsForRegion(region, def)}
                onReset={() => resetWaferBinsForRegion(region)}
              />
            )}
            {region && customWaferBins[region] && (
              <Button variant="outline" size="sm" onClick={() => resetWaferBinsForRegion(region)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset Buckets
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Wafer x Power Block chart */}
      <Card>
        <CardHeader>
          <CardTitle>{region ? tssRegionLabel(region) : 'Select a region'} — Wafer by Power Block</CardTitle>
        </CardHeader>
        <CardContent>
          {detailLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : detailError ? (
            <div className="flex items-center gap-2 py-8 text-red-600">
              <AlertTriangle className="h-4 w-4" /> {String(detailError)}
            </div>
          ) : (
            <BarChart option={chartOption} height={380} />
          )}
        </CardContent>
      </Card>

      {/* Wafer totals table */}
      <Card>
        <CardHeader>
          <CardTitle>Wafer Totals — {region ? tssRegionLabel(region) : ''}</CardTitle>
        </CardHeader>
        <CardContent>
          {!detail || detail.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> No wafer data for this region.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Wafer</TableHead>
                  <TableHead>{unitLabel}</TableHead>
                  <TableHead>% of Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {WAFER_ORDER.filter((w) => totalsByWafer.has(w)).map((wafer) => {
                  const val = totalsByWafer.get(wafer) ?? 0
                  const pct = grandTotal > 0 ? (val / grandTotal) * 100 : 0
                  return (
                    <TableRow key={wafer}>
                      <TableCell className="font-medium">
                        <span
                          className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: WAFER_COLORS[wafer] }}
                        />
                        {wafer}
                      </TableCell>
                      <TableCell>{val.toLocaleString()}</TableCell>
                      <TableCell>{pct.toFixed(1)}%</TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell>{grandTotal.toLocaleString()}</TableCell>
                  <TableCell>100.0%</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
