import { useMemo, useState, useEffect } from 'react'
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  BarChart3,
  Settings2,
  Info,
} from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import SiteSelector from '@/components/filters/SiteSelector'
import DateRangePicker from '@/components/filters/DateRangePicker'
import BarChart from '@/components/charts/BarChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import { useDataStore } from '@/store/dataStore'
import { useUIStore } from '@/store/uiStore'
import { query as duckQuery } from '@/lib/duckdb'
import { buildDateFilter } from '@/lib/queries'

// ── Parameter definitions ──────────────────────────────────────────

interface ParamDef {
  key: string
  label: string
  unit: string
  expr: string
  defaultInterval: number
}

const BUCKET_PARAMS: ParamDef[] = [
  { key: 'temperature_c', label: 'Temperature', unit: '°C', expr: '(temperature_f - 32) * 5.0 / 9.0', defaultInterval: 10 },
  { key: 'dc_power', label: 'DC Power', unit: 'W', expr: 'dc_current * dc_voltage', defaultInterval: 50 },
  { key: 'ac_power', label: 'AC Power', unit: 'W', expr: 'CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END', defaultInterval: 50 },
  { key: 'dc_voltage', label: 'DC Voltage', unit: 'V', expr: 'dc_voltage', defaultInterval: 5 },
  { key: 'dc_current', label: 'DC Current', unit: 'A', expr: 'dc_current', defaultInterval: 2 },
  { key: 'ac_voltage', label: 'AC Voltage', unit: 'V', expr: 'ac_voltage', defaultInterval: 10 },
  { key: 'ac_frequency', label: 'AC Frequency', unit: 'Hz', expr: 'ac_frequency', defaultInterval: 1 },
]

type AggMode = 'sum' | 'avg' | 'count' | 'max' | 'min'

interface YAxisDef {
  key: string
  label: string
  unit: string
  expr: string
  aggDefault: AggMode
}

const Y_AXIS_PARAMS: YAxisDef[] = [
  { key: 'energy_produced', label: 'Energy Produced', unit: 'kWh', expr: 'energy_produced / 1000.0', aggDefault: 'sum' },
  { key: 'dc_power', label: 'DC Power', unit: 'W', expr: 'dc_current * dc_voltage', aggDefault: 'avg' },
  { key: 'ac_power', label: 'AC Power', unit: 'W', expr: 'CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END', aggDefault: 'avg' },
  { key: 'duration', label: 'Duration', unit: 's', expr: 'duration', aggDefault: 'sum' },
  { key: 'data_points', label: 'Data Points', unit: '', expr: '1', aggDefault: 'count' },
  { key: 'temperature_c', label: 'Temperature', unit: '°C', expr: '(temperature_f - 32) * 5.0 / 9.0', aggDefault: 'avg' },
  { key: 'dc_voltage', label: 'DC Voltage', unit: 'V', expr: 'dc_voltage', aggDefault: 'avg' },
  { key: 'dc_current', label: 'DC Current', unit: 'A', expr: 'dc_current', aggDefault: 'avg' },
  { key: 'ac_voltage', label: 'AC Voltage', unit: 'V', expr: 'ac_voltage', aggDefault: 'avg' },
  { key: 'ac_frequency', label: 'AC Frequency', unit: 'Hz', expr: 'ac_frequency', aggDefault: 'avg' },
]

const AGG_LABELS: Record<AggMode, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  max: 'Max',
  min: 'Min',
}

const CHART_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
]

// ── Helpers ──────────────────────────────────────────────────────────

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = typeof n === 'bigint' ? Number(n) : Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// ── Row type from bucket query ───────────────────────────────────────

interface BucketRow {
  bucket_start: number
  bucket_end: number
  bucket_label: string
  y_value: number
  data_points: number
}

// ── Component ────────────────────────────────────────────────────────

export default function BucketAnalysisPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)
  const dateRange = useDataStore((s) => s.dateRange)
  const selectedSites = useUIStore((s) => s.selectedSites)
  const setSelectedSites = useUIStore((s) => s.setSelectedSites)

  // X axis config
  const [xParam, setXParam] = useState(BUCKET_PARAMS[0].key)
  const [interval, setInterval] = useState(String(BUCKET_PARAMS[0].defaultInterval))

  // Y axis config
  const [yParam, setYParam] = useState(Y_AXIS_PARAMS[0].key)
  const [aggMode, setAggMode] = useState<AggMode>(Y_AXIS_PARAMS[0].aggDefault)

  // UI state
  const [statsOpen, setStatsOpen] = useState(true)
  const [configOpen, setConfigOpen] = useState(true)

  // Default site selection
  useEffect(() => {
    if (selectedSites.length === 0 && allSites.length > 0) {
      setSelectedSites([...allSites])
    }
  }, [allSites, selectedSites.length, setSelectedSites])

  // Update defaults when x-param changes
  useEffect(() => {
    const def = BUCKET_PARAMS.find((p) => p.key === xParam)
    if (def) setInterval(String(def.defaultInterval))
  }, [xParam])

  // Update agg mode when y-param changes
  useEffect(() => {
    const def = Y_AXIS_PARAMS.find((p) => p.key === yParam)
    if (def) setAggMode(def.aggDefault)
  }, [yParam])

  const xDef = BUCKET_PARAMS.find((p) => p.key === xParam)!
  const yDef = Y_AXIS_PARAMS.find((p) => p.key === yParam)!
  const intervalNum = Math.max(Number(interval) || 1, 0.01)

  // Build and execute the bucket query
  const { data: bucketData, isLoading } = useQuery<BucketRow[]>({
    queryKey: ['bucket-analysis', xParam, yParam, aggMode, intervalNum, selectedSites, dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      const df = buildDateFilter(dateRange)
      const siteFilter = selectedSites.length > 0
        ? `AND site_id IN (${selectedSites.map((s) => `'${s}'`).join(', ')})`
        : ''

      // Build the aggregation expression over y_raw (already computed in the CTE)
      let aggExpr: string
      if (yParam === 'data_points') {
        aggExpr = 'COUNT(*)'
      } else {
        switch (aggMode) {
          case 'sum': aggExpr = 'SUM(y_raw)'; break
          case 'avg': aggExpr = 'AVG(y_raw)'; break
          case 'count': aggExpr = 'COUNT(y_raw)'; break
          case 'max': aggExpr = 'MAX(y_raw)'; break
          case 'min': aggExpr = 'MIN(y_raw)'; break
        }
      }

      const sql = `
        WITH bucketed AS (
          SELECT
            FLOOR((${xDef.expr}) / ${intervalNum}) * ${intervalNum} AS bucket_start,
            ${yDef.expr} AS y_raw,
            1 AS cnt
          FROM telemetry
          WHERE 1=1
            ${siteFilter}
            ${df}
            AND (${xDef.expr}) IS NOT NULL
        )
        SELECT
          bucket_start,
          bucket_start + ${intervalNum} AS bucket_end,
          CAST(ROUND(bucket_start, 2) AS VARCHAR) || ' – ' || CAST(ROUND(bucket_start + ${intervalNum}, 2) AS VARCHAR) AS bucket_label,
          ${aggExpr} AS y_value,
          COUNT(*) AS data_points
        FROM bucketed
        GROUP BY bucket_start
        ORDER BY bucket_start
      `
      return duckQuery<BucketRow>(sql)
    },
    enabled: isDataLoaded && selectedSites.length > 0,
  })

  const rows = bucketData ?? []

  // Chart option
  const chartOption = useMemo((): EChartsOption => {
    if (rows.length === 0) return {}

    const labels = rows.map((r) => String(r.bucket_label))
    const values = rows.map((r) => safe(r.y_value))
    const dataPoints = rows.map((r) => safe(r.data_points))
    const maxVal = Math.max(...values)

    // Color gradient based on value intensity
    const barData = values.map((v) => {
      const intensity = maxVal > 0 ? v / maxVal : 0
      const colorIdx = Math.min(Math.floor(intensity * (CHART_COLORS.length - 1)), CHART_COLORS.length - 1)
      return {
        value: v,
        itemStyle: {
          color: CHART_COLORS[colorIdx],
          borderRadius: [4, 4, 0, 0],
        },
      }
    })

    const yLabel = yParam === 'data_points'
      ? 'Data Points'
      : `${AGG_LABELS[aggMode]} ${yDef.label} (${yDef.unit})`

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (params as { dataIndex: number; name: string; value: number }[])[0]
          if (!p) return ''
          const dp = dataPoints[p.dataIndex]
          return `
            <div style="font-weight:600;margin-bottom:4px">${xDef.label}: ${p.name} ${xDef.unit}</div>
            <div>${yLabel}: <b>${fmt(p.value)}</b></div>
            <div style="color:#888;font-size:12px">Data points: ${dp.toLocaleString()}</div>
          `
        },
      },
      grid: { top: 50, right: 30, bottom: 80, left: 75 },
      xAxis: {
        type: 'category',
        data: labels,
        name: `${xDef.label} (${xDef.unit})`,
        nameLocation: 'middle',
        nameGap: 50,
        nameTextStyle: { fontSize: 12, fontWeight: 'bold' },
        axisLabel: { rotate: 35, fontSize: 10, interval: 0 },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value',
        name: yLabel,
        nameTextStyle: { fontSize: 11, fontWeight: 'bold' },
        axisLabel: { fontSize: 10 },
        splitLine: { lineStyle: { type: 'dashed', opacity: 0.3 } },
      },
      series: [
        {
          type: 'bar',
          data: barData,
          barMaxWidth: 60,
          label: {
            show: rows.length <= 30,
            position: 'top',
            fontSize: 9,
            formatter: (p: unknown) => {
              const val = safe((p as { value: number }).value)
              if (val >= 1000) return `${(val / 1000).toFixed(1)}k`
              return fmt(val, 1)
            },
          },
        },
      ],
      dataZoom: rows.length > 20
        ? [{ type: 'inside' }, { type: 'slider', bottom: 5, height: 22 }]
        : [],
    }
  }, [rows, xDef, yDef, yParam, aggMode])

  // Stats
  const stats = useMemo(() => {
    if (rows.length === 0) return null
    const values = rows.map((r) => safe(r.y_value))
    const dpValues = rows.map((r) => safe(r.data_points))
    const totalDP = dpValues.reduce((a, b) => a + b, 0)
    const totalY = values.reduce((a, b) => a + b, 0)
    const meanY = values.length > 0 ? totalY / values.length : 0
    const maxY = Math.max(...values)
    const minY = Math.min(...values)
    const variance = values.length > 0
      ? values.reduce((a, v) => a + (v - meanY) ** 2, 0) / values.length
      : 0
    const stdDev = Math.sqrt(variance)

    // Find peak bucket
    const peakIdx = values.indexOf(maxY)
    const peakBucket = rows[peakIdx]?.bucket_label ?? '—'

    // Find the bucket with most data points
    const maxDP = Math.max(...dpValues)
    const maxDPIdx = dpValues.indexOf(maxDP)
    const densestBucket = rows[maxDPIdx]?.bucket_label ?? '—'

    return {
      bucketCount: rows.length,
      totalDataPoints: totalDP,
      totalY,
      meanY,
      maxY,
      minY,
      stdDev,
      peakBucket,
      densestBucket,
      maxDP,
    }
  }, [rows])

  // Export data
  const exportData = useMemo(() => {
    return rows.map((r) => ({
      bucket: r.bucket_label,
      value: safe(r.y_value),
      data_points: safe(r.data_points),
    }))
  }, [rows])

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">
          No data loaded. <a href="#/upload" className="underline text-primary">Upload data</a> first.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bucket Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Group data into intervals and analyze distributions across parameters
          </p>
        </div>
        <ExportToolbar
          elementId="bucket-content"
          filename="compdash-bucket-analysis"
          data={exportData as unknown as Record<string, unknown>[]}
        />
      </div>

      <div id="bucket-content">
        {/* Configuration Panel */}
        <Card>
          <CardHeader
            className="cursor-pointer select-none"
            onClick={() => setConfigOpen((o) => !o)}
          >
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="h-4 w-4" />
              Configuration
              {configOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
            </CardTitle>
          </CardHeader>
          {configOpen && (
            <CardContent className="space-y-5">
              {/* Site + Date filters */}
              <div className="flex flex-wrap items-start gap-4">
                <SiteSelector
                  allSites={allSites}
                  selectedSites={selectedSites}
                  onChange={setSelectedSites}
                />
                <DateRangePicker />
              </div>

              {/* X-Axis & Y-Axis config */}
              <div className="grid gap-6 sm:grid-cols-2">
                {/* X-Axis */}
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900/50 dark:bg-blue-950/20">
                  <div className="mb-3 flex items-center gap-2">
                    <Badge variant="default" className="bg-blue-600">X-Axis</Badge>
                    <span className="text-sm font-semibold">Bucket Parameter</span>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Parameter</label>
                      <Select value={xParam} onValueChange={(v) => { if (v) setXParam(v) }}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BUCKET_PARAMS.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              {p.label} ({p.unit})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Interval Size ({xDef.unit})
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min="0.01"
                          step="any"
                          value={interval}
                          onChange={(e) => setInterval(e.target.value)}
                          className="w-28"
                        />
                        <span className="text-xs text-muted-foreground">{xDef.unit}</span>
                        <div className="ml-auto flex gap-1">
                          {[0.5, 1, 2].map((mult) => (
                            <Button
                              key={mult}
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => setInterval(String(xDef.defaultInterval * mult))}
                            >
                              {mult === 1 ? 'Default' : `×${mult}`}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Y-Axis */}
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
                  <div className="mb-3 flex items-center gap-2">
                    <Badge variant="default" className="bg-emerald-600">Y-Axis</Badge>
                    <span className="text-sm font-semibold">Measured Value</span>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Parameter</label>
                      <Select value={yParam} onValueChange={(v) => { if (v) setYParam(v) }}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Y_AXIS_PARAMS.map((p) => (
                            <SelectItem key={p.key} value={p.key}>
                              {p.label} ({p.unit || '#'})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {yParam !== 'data_points' && (
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Aggregation</label>
                        <Select value={aggMode} onValueChange={(v) => { if (v) setAggMode(v as AggMode) }}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.keys(AGG_LABELS) as AggMode[]).map((m) => (
                              <SelectItem key={m} value={m}>{AGG_LABELS[m]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Current config summary */}
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
                <Info className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Grouping <strong>{xDef.label}</strong> into <strong>{intervalNum}{xDef.unit}</strong> intervals,
                  showing <strong>{yParam === 'data_points' ? 'Count' : AGG_LABELS[aggMode]}</strong> of{' '}
                  <strong>{yDef.label}</strong> per bucket
                </span>
              </div>
            </CardContent>
          )}
        </Card>

        {/* Chart */}
        {isLoading ? (
          <Card>
            <CardContent>
              <div className="flex items-center justify-center py-20 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Computing buckets…
              </div>
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <CardContent>
              <p className="py-16 text-center text-sm text-muted-foreground">
                No data for the selected parameters and sites.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="h-4 w-4" />
                {xDef.label} vs {yDef.label}
                <Badge variant="secondary" className="ml-2">
                  {rows.length} buckets
                </Badge>
                {stats && (
                  <Badge variant="outline" className="ml-1">
                    {stats.totalDataPoints.toLocaleString()} data points
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BarChart option={chartOption} height={450} />
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        {stats && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs font-medium text-muted-foreground">Peak Bucket</p>
                <p className="mt-1 text-lg font-bold">{stats.peakBucket} {xDef.unit}</p>
                <p className="text-sm text-muted-foreground">
                  {yParam === 'data_points' ? 'Count' : AGG_LABELS[aggMode]}: {fmt(stats.maxY)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs font-medium text-muted-foreground">Densest Bucket</p>
                <p className="mt-1 text-lg font-bold">{stats.densestBucket} {xDef.unit}</p>
                <p className="text-sm text-muted-foreground">
                  {stats.maxDP.toLocaleString()} data points
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs font-medium text-muted-foreground">Mean Across Buckets</p>
                <p className="mt-1 text-lg font-bold">{fmt(stats.meanY)}</p>
                <p className="text-sm text-muted-foreground">
                  Std Dev: {fmt(stats.stdDev)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-xs font-medium text-muted-foreground">Total</p>
                <p className="mt-1 text-lg font-bold">{fmt(stats.totalY)}</p>
                <p className="text-sm text-muted-foreground">
                  {stats.bucketCount} buckets · {stats.totalDataPoints.toLocaleString()} pts
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Stats Table */}
        {rows.length > 0 && (
          <Card>
            <CardHeader
              className="cursor-pointer select-none"
              onClick={() => setStatsOpen((o) => !o)}
            >
              <CardTitle className="flex items-center gap-2 text-base">
                {statsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Bucket Details
              </CardTitle>
            </CardHeader>
            {statsOpen && (
              <CardContent>
                <div className="max-h-[500px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky top-0 bg-background">
                          {xDef.label} Range ({xDef.unit})
                        </TableHead>
                        <TableHead className="sticky top-0 bg-background text-right">
                          {yParam === 'data_points' ? 'Count' : `${AGG_LABELS[aggMode]} ${yDef.label} (${yDef.unit})`}
                        </TableHead>
                        <TableHead className="sticky top-0 bg-background text-right">
                          Data Points
                        </TableHead>
                        <TableHead className="sticky top-0 bg-background text-right">
                          % of Total
                        </TableHead>
                        <TableHead className="sticky top-0 bg-background">
                          Distribution
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r, i) => {
                        const val = safe(r.y_value)
                        const dp = safe(r.data_points)
                        const totalY = rows.reduce((a, b) => a + safe(b.y_value), 0)
                        const pct = totalY > 0 ? (val / totalY) * 100 : 0
                        const maxVal = Math.max(...rows.map((r) => safe(r.y_value)))
                        const barWidth = maxVal > 0 ? (val / maxVal) * 100 : 0
                        return (
                          <TableRow key={i}>
                            <TableCell className="font-medium">{r.bucket_label}</TableCell>
                            <TableCell className="text-right font-mono">{fmt(val)}</TableCell>
                            <TableCell className="text-right font-mono">{dp.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono">{fmt(pct, 1)}%</TableCell>
                            <TableCell className="w-40">
                              <div className="flex items-center gap-2">
                                <div className="h-2.5 rounded-full bg-muted flex-1">
                                  <div
                                    className="h-full rounded-full bg-primary transition-all"
                                    style={{ width: `${barWidth}%` }}
                                  />
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}
