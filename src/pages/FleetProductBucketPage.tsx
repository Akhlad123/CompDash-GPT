import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertTriangle, RotateCcw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import PowerBucketEditor from '@/components/fleet/PowerBucketEditor'
import ExportToolbar from '@/components/export/ExportToolbar'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter, FLEET_DISTINCT_TSS_REGIONS, FLEET_DISTINCT_TSS_COUNTRIES,
  FLEET_PRODUCT_TYPE_BY_BUCKET, FLEET_MODULE_MAKE_BREAKDOWN,
  FLEET_DISTINCT_QUARTERS,
} from '@/lib/fleetQueries'
import { DEFAULT_PRODUCT_POWER_BINS, buildPowerBucketCaseSql, tssRegionLabel } from '@/lib/fleetRegions'

interface ProductBucketRow {
  product_type: string
  bucket_label: string
  value: number
}

interface ModuleMakeRow {
  pv_module_make: string
  value: number
  avg_power_w: number | null
}

const NO_DATA_LABEL = 'No module data'

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

export default function FleetProductBucketPage() {
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
  const customProductBins = useFleetStore((s) => s.customProductBins)
  const setProductBins = useFleetStore((s) => s.setProductBins)
  const resetProductBins = useFleetStore((s) => s.resetProductBins)

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
  const unitLabel = aggMode === 'sites' ? 'Sites' : 'Units'

  const effectiveBins = customProductBins ?? DEFAULT_PRODUCT_POWER_BINS
  const bucketExpr = customProductBins
    ? buildPowerBucketCaseSql(customProductBins)
    : 'power_bucket'

  const { data: pivotRows, isLoading: pivotLoading, error: pivotError } = useQuery({
    queryKey: ['fleet-product-bucket-pivot', where, aggMode, bucketExpr],
    queryFn: () => query<ProductBucketRow>(FLEET_PRODUCT_TYPE_BY_BUCKET(where, aggMode, bucketExpr)),
    enabled: isFleetLoaded,
  })

  const { data: makeRows, isLoading: makeLoading, error: makeError } = useQuery({
    queryKey: ['fleet-module-make', where, aggMode],
    queryFn: () => query<ModuleMakeRow>(FLEET_MODULE_MAKE_BREAKDOWN(where, aggMode)),
    enabled: isFleetLoaded,
  })

  // ── Pivot table: Product Type (rows) x Power Bucket (columns) ──────────
  const pivot = useMemo(() => {
    if (!pivotRows || pivotRows.length === 0) return null
    const bucketCols = effectiveBins.labels.filter((l) =>
      pivotRows.some((r) => r.bucket_label === l)
    )
    const hasNoData = pivotRows.some((r) => r.bucket_label === NO_DATA_LABEL)
    const cols = [...bucketCols, ...(hasNoData ? [NO_DATA_LABEL] : [])]

    const products = Array.from(new Set(pivotRows.map((r) => r.product_type)))
    const rows = products.map((product) => {
      const cellValues = cols.map((col) => {
        const row = pivotRows.find((r) => r.product_type === product && r.bucket_label === col)
        return row ? safe(row.value) : 0
      })
      const total = cellValues.reduce((a, b) => a + b, 0)
      return { product, cellValues, total }
    }).sort((a, b) => b.total - a.total)

    const grandTotal = rows.reduce((sum, r) => sum + r.total, 0)
    const colTotals = cols.map((_, ci) => rows.reduce((sum, r) => sum + r.cellValues[ci], 0))

    return { cols, rows, grandTotal, colTotals }
  }, [pivotRows, effectiveBins])

  // ── Module make table ───────────────────────────────────────────────────
  const makeTable = useMemo(() => {
    if (!makeRows || makeRows.length === 0) return null
    const grandTotal = makeRows.reduce((sum, r) => sum + safe(r.value), 0)
    const sorted = [...makeRows].sort((a, b) => {
      if (a.pv_module_make === NO_DATA_LABEL) return 1
      if (b.pv_module_make === NO_DATA_LABEL) return -1
      return safe(b.value) - safe(a.value)
    })
    return { rows: sorted, grandTotal }
  }, [makeRows])

  const pivotExportData = useMemo(() => {
    if (!pivot) return []
    return pivot.rows.map((r) => {
      const rec: Record<string, unknown> = { 'Product Type': r.product }
      pivot.cols.forEach((col, i) => { rec[col] = r.cellValues[i] })
      rec['Total'] = r.total
      rec['% of Total'] = pivot.grandTotal > 0 ? `${((r.total / pivot.grandTotal) * 100).toFixed(1)}%` : '0%'
      return rec
    })
  }, [pivot])

  const makeExportData = useMemo(() => {
    if (!makeTable) return []
    return makeTable.rows.map((r) => ({
      'PV Module Make': r.pv_module_make,
      'Average Power (W)': r.avg_power_w != null ? Number(r.avg_power_w).toFixed(1) : '—',
      [unitLabel]: safe(r.value),
      '% of Total': makeTable.grandTotal > 0 ? `${((safe(r.value) / makeTable.grandTotal) * 100).toFixed(1)}%` : '0%',
    }))
  }, [makeTable, unitLabel])

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
        <h1 className="text-3xl font-bold tracking-tight">Product Bucket</h1>
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
          <div className="ml-auto flex items-center gap-2">
            <PowerBucketEditor
              value={effectiveBins}
              defaultValue={DEFAULT_PRODUCT_POWER_BINS}
              onSave={setProductBins}
              onReset={resetProductBins}
            />
            {customProductBins && (
              <Button variant="outline" size="sm" onClick={resetProductBins}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset Buckets
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Pivot table: Product Type x Power Bucket */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Inverter Pairing by Power Bucket ({unitLabel})</CardTitle>
          <ExportToolbar elementId="product-bucket-pivot" filename="product-bucket-pivot" data={pivotExportData} />
        </CardHeader>
        <CardContent id="product-bucket-pivot" className="overflow-x-auto">
          {pivotLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : pivotError ? (
            <div className="flex items-center gap-2 py-8 text-red-600">
              <AlertTriangle className="h-4 w-4" /> {String(pivotError)}
            </div>
          ) : !pivot ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> No data matches the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-card">Product Type</TableHead>
                  {pivot.cols.map((col) => (
                    <TableHead key={col} className={col === NO_DATA_LABEL ? 'text-amber-600' : ''}>
                      {col}
                    </TableHead>
                  ))}
                  <TableHead className="font-semibold">Total</TableHead>
                  <TableHead className="font-semibold">% of Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pivot.rows.map((row) => (
                  <TableRow key={row.product}>
                    <TableCell className="sticky left-0 bg-card font-medium">{row.product}</TableCell>
                    {row.cellValues.map((v, i) => (
                      <TableCell key={i}>{v.toLocaleString()}</TableCell>
                    ))}
                    <TableCell className="font-semibold">{row.total.toLocaleString()}</TableCell>
                    <TableCell>
                      {pivot.grandTotal > 0 ? `${((row.total / pivot.grandTotal) * 100).toFixed(1)}%` : '0.0%'}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell className="sticky left-0 bg-card">Total</TableCell>
                  {pivot.colTotals.map((v, i) => (
                    <TableCell key={i}>
                      {v.toLocaleString()}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        ({pivot.grandTotal > 0 ? ((v / pivot.grandTotal) * 100).toFixed(1) : '0.0'}%)
                      </span>
                    </TableCell>
                  ))}
                  <TableCell>{pivot.grandTotal.toLocaleString()}</TableCell>
                  <TableCell>100.0%</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Module make breakdown */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Module Make by Installation ({unitLabel})</CardTitle>
          <ExportToolbar elementId="product-bucket-make" filename="module-make-breakdown" data={makeExportData} />
        </CardHeader>
        <CardContent id="product-bucket-make" className="overflow-x-auto">
          {makeLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : makeError ? (
            <div className="flex items-center gap-2 py-8 text-red-600">
              <AlertTriangle className="h-4 w-4" /> {String(makeError)}
            </div>
          ) : !makeTable ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> No data matches the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PV Module Make</TableHead>
                  <TableHead>Average Power (W)</TableHead>
                  <TableHead>{unitLabel}</TableHead>
                  <TableHead>% of Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {makeTable.rows.map((row) => {
                  const val = safe(row.value)
                  const pct = makeTable.grandTotal > 0 ? (val / makeTable.grandTotal) * 100 : 0
                  const isNoData = row.pv_module_make === NO_DATA_LABEL
                  return (
                    <TableRow key={row.pv_module_make}>
                      <TableCell className={`font-medium ${isNoData ? 'text-amber-600' : ''}`}>
                        {row.pv_module_make}
                      </TableCell>
                      <TableCell>{row.avg_power_w != null ? Number(row.avg_power_w).toFixed(1) : '—'}</TableCell>
                      <TableCell>{val.toLocaleString()}</TableCell>
                      <TableCell>{pct.toFixed(1)}%</TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell>{makeTable.grandTotal.toLocaleString()}</TableCell>
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
