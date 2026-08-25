import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2, AlertTriangle, MapPin, Zap, Layers, ArrowRight, CheckSquare, Square,
  CheckCircle2, XCircle, Boxes,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import KPICard from '@/components/layout/KPICard'
import BarChart from '@/components/charts/BarChart'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter, FLEET_REGION_SUMMARY, FLEET_WAFER_SHARE_BY_TSS_REGION,
  FLEET_DISTINCT_QUARTERS,
  FLEET_DISTINCT_TSS_REGIONS, FLEET_DISTINCT_TSS_COUNTRIES,
  FLEET_MODULE_DATA_SUMMARY, FLEET_DISTINCT_PRODUCT_TYPES,
} from '@/lib/fleetQueries'
import { WAFER_ORDER, WAFER_COLORS, tssRegionLabel } from '@/lib/fleetRegions'
import type { EChartsOption } from 'echarts'

interface RegionSummaryRow {
  tss_region: string
  site_count: number
  total_units: number
  units_with: number
  units_without: number
  total_stc_mwdc: number
  total_mwac: number
  avg_stc_rating: number | null
  median_stc: number | null
  p75_stc: number | null
  avg_dc_ac: number | null
}

interface WaferShareRow {
  tss_region: string
  module_wafer: string
  units: number
}

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function MultiSelectBadges({
  label, options, selected, onChange,
}: { label: string; options: string[]; selected: string[]; onChange: (v: string[]) => void }) {
  const allSelected = selected.length === 0 || selected.length === options.length
  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((s) => s !== v))
    else onChange([...selected, v])
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}:</span>
        <Button variant="ghost" size="xs" onClick={() => onChange([])}>
          {allSelected ? <CheckSquare className="mr-1 h-3.5 w-3.5" /> : <Square className="mr-1 h-3.5 w-3.5" />}
          All
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <Badge
            key={opt}
            variant={allSelected || selected.includes(opt) ? 'default' : 'secondary'}
            className="cursor-pointer select-none"
            onClick={() => toggle(opt)}
          >
            {opt}
          </Badge>
        ))}
      </div>
    </div>
  )
}

export default function FleetOverviewPage() {
  const navigate = useNavigate()
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)
  const selectedQuarters = useFleetStore((s) => s.selectedQuarters)
  const setSelectedQuarters = useFleetStore((s) => s.setSelectedQuarters)
  const selectedTssRegions = useFleetStore((s) => s.selectedTssRegions)
  const setSelectedTssRegions = useFleetStore((s) => s.setSelectedTssRegions)
  const selectedTssCountries = useFleetStore((s) => s.selectedTssCountries)
  const setSelectedTssCountries = useFleetStore((s) => s.setSelectedTssCountries)
  const aggMode = useFleetStore((s) => s.aggMode)
  const setAggMode = useFleetStore((s) => s.setAggMode)

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
  const { data: productTypes } = useQuery({
    queryKey: ['fleet-product-types'],
    queryFn: () => query<{ product_type: string }>(FLEET_DISTINCT_PRODUCT_TYPES),
    enabled: isFleetLoaded,
  })

  const where = buildFleetFilter({
    quarters: selectedQuarters,
    tssRegions: selectedTssRegions,
    tssCountries: selectedTssCountries,
  })
  const unitLabel = aggMode === 'sites' ? 'Sites' : 'Units'

  const { data: regionSummary, isLoading: summaryLoading, error: summaryError } = useQuery({
    queryKey: ['fleet-region-summary', where, aggMode],
    queryFn: () => query<RegionSummaryRow>(FLEET_REGION_SUMMARY(where, aggMode)),
    enabled: isFleetLoaded,
  })

  const { data: waferShare } = useQuery({
    queryKey: ['fleet-wafer-share', where, aggMode],
    queryFn: () => query<WaferShareRow>(FLEET_WAFER_SHARE_BY_TSS_REGION(where, aggMode)),
    enabled: isFleetLoaded,
  })

  const { data: moduleDataSummary } = useQuery({
    queryKey: ['fleet-module-data-summary', where],
    queryFn: () => query<{ bucket: string; sites: number; units: number }>(FLEET_MODULE_DATA_SUMMARY(where)),
    enabled: isFleetLoaded,
  })

  const kpi = useMemo(() => {
    if (!regionSummary) return null
    return regionSummary.reduce(
      (acc, r) => ({
        sites: acc.sites + safe(r.site_count),
        units: acc.units + safe(r.total_units),
        mwdc: acc.mwdc + safe(r.total_stc_mwdc),
        mwac: acc.mwac + safe(r.total_mwac),
      }),
      { sites: 0, units: 0, mwdc: 0, mwac: 0 }
    )
  }, [regionSummary])

  const dataSummary = useMemo(() => {
    if (!moduleDataSummary) return null
    const withRow = moduleDataSummary.find((r) => r.bucket === 'with_data')
    const withoutRow = moduleDataSummary.find((r) => r.bucket === 'without_data')
    return {
      sitesWith: safe(withRow?.sites),
      sitesWithout: safe(withoutRow?.sites),
      unitsWith: safe(withRow?.units),
      unitsWithout: safe(withoutRow?.units),
    }
  }, [moduleDataSummary])

  const waferChartOption = useMemo<EChartsOption>(() => {
    if (!waferShare || waferShare.length === 0) return {}
    const regionList = Array.from(new Set(waferShare.map((r) => r.tss_region)))
    const series = WAFER_ORDER.map((wafer) => ({
      name: wafer,
      type: 'bar' as const,
      stack: 'wafer',
      color: WAFER_COLORS[wafer],
      data: regionList.map((region) => {
        const row = waferShare.find((r) => r.tss_region === region && r.module_wafer === wafer)
        return row ? safe(row.units) : 0
      }),
    }))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 60, right: 20, top: 40, bottom: 80 },
      xAxis: {
        type: 'category',
        data: regionList.map(tssRegionLabel),
        axisLabel: { rotate: 20, fontSize: 11 },
      },
      yAxis: { type: 'value', name: unitLabel },
      series,
    }
  }, [waferShare, unitLabel])

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Fleet Overview</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Aggregate by:</span>
          <Tabs value={aggMode} onValueChange={(v) => setAggMode(v as 'units' | 'sites')}>
            <TabsList>
              <TabsTrigger value="units">Units</TabsTrigger>
              <TabsTrigger value="sites">Sites</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" onClick={() => navigate('/fleet/wafer')}>
            Wafer Detail <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={() => navigate('/fleet/products')}>
            Product Bucket <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      {kpi && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard icon={MapPin} label="Sites" value={kpi.sites.toLocaleString()} />
          <KPICard icon={Layers} label="Microinverter Units" value={kpi.units.toLocaleString()} />
          <KPICard icon={Zap} label="Total STC MWdc" value={kpi.mwdc.toFixed(2)} />
          <KPICard icon={Zap} label="Total MWac" value={kpi.mwac.toFixed(2)} />
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-4 pb-4 sm:flex-row sm:flex-wrap sm:items-start sm:gap-8">
          <MultiSelectBadges
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

      {/* Data summary */}
      <Card>
        <CardHeader>
          <CardTitle>Data Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-xs text-muted-foreground">Sites with module data</p>
                <p className="text-lg font-semibold">{(dataSummary?.sitesWith ?? 0).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">{(dataSummary?.unitsWith ?? 0).toLocaleString()} units with module data</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3">
              <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <p className="text-xs text-muted-foreground">Sites without module data</p>
                <p className="text-lg font-semibold">{(dataSummary?.sitesWithout ?? 0).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">{(dataSummary?.unitsWithout ?? 0).toLocaleString()} units without module data</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3 sm:col-span-2">
              <Boxes className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
              <div>
                <p className="text-xs text-muted-foreground">
                  Product types considered ({(productTypes ?? []).length})
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(productTypes ?? []).map((p) => (
                    <Badge key={p.product_type} variant="secondary" className="text-xs">
                      {p.product_type}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Wafer share chart */}
      <Card>
        <CardHeader>
          <CardTitle>Wafer Share by Region</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart option={waferChartOption} height={380} />
        </CardContent>
      </Card>

      {/* Region summary table */}
      <Card>
        <CardHeader>
          <CardTitle>Region Summary</CardTitle>
        </CardHeader>
        <CardContent>
          {summaryLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : summaryError ? (
            <div className="flex items-center gap-2 py-8 text-red-600">
              <AlertTriangle className="h-4 w-4" /> {String(summaryError)}
            </div>
          ) : !regionSummary || regionSummary.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> No fleet data matches the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Region</TableHead>
                    <TableHead>Sites</TableHead>
                    <TableHead>{unitLabel}</TableHead>
                    <TableHead>Units w/o Module Data</TableHead>
                    <TableHead>STC MWdc</TableHead>
                    <TableHead>MWac</TableHead>
                    <TableHead>Avg STC (W)</TableHead>
                    <TableHead>Median STC (W)</TableHead>
                    <TableHead>P75 STC (W)</TableHead>
                    <TableHead>Avg DC/AC</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {regionSummary.map((row) => (
                    <TableRow key={row.tss_region}>
                      <TableCell className="font-medium">{tssRegionLabel(row.tss_region)}</TableCell>
                      <TableCell>{safe(row.site_count).toLocaleString()}</TableCell>
                      <TableCell>{safe(row.total_units).toLocaleString()}</TableCell>
                      <TableCell className="text-amber-600">{safe(row.units_without).toLocaleString()}</TableCell>
                      <TableCell>{safe(row.total_stc_mwdc).toFixed(2)}</TableCell>
                      <TableCell>{safe(row.total_mwac).toFixed(2)}</TableCell>
                      <TableCell>{row.avg_stc_rating != null ? safe(row.avg_stc_rating).toFixed(0) : '—'}</TableCell>
                      <TableCell>{row.median_stc != null ? safe(row.median_stc).toFixed(0) : '—'}</TableCell>
                      <TableCell>{row.p75_stc != null ? safe(row.p75_stc).toFixed(0) : '—'}</TableCell>
                      <TableCell>{row.avg_dc_ac != null ? safe(row.avg_dc_ac).toFixed(2) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
