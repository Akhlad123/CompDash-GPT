import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import {
  Loader2,
  GripVertical,
  Plus,
  X,
  Download,
  Table2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import InverterSelector from '@/components/filters/InverterSelector'
import DateRangePicker from '@/components/filters/DateRangePicker'
import GranularityToggle from '@/components/filters/GranularityToggle'
import LineChart from '@/components/charts/LineChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import { useDataStore } from '@/store/dataStore'
import { useUIStore } from '@/store/uiStore'
import { useMultiMetricTimeSeries } from '@/hooks/useMultiMetricTimeSeries'
import type { MetricKey } from '@/lib/queries'

// ── Metric definitions ──────────────────────────────────────────────

interface MetricDef {
  key: MetricKey
  label: string
  unit: string
  color: string
}

const ALL_METRICS: MetricDef[] = [
  { key: 'dc_power', label: 'DC Power', unit: 'W', color: '#3b82f6' },
  { key: 'ac_power', label: 'AC Power', unit: 'W', color: '#10b981' },
  { key: 'energy_produced', label: 'Energy Produced', unit: 'kWh', color: '#22c55e' },
  { key: 'temperature_c', label: 'Temperature', unit: '°C', color: '#ef4444' },
  { key: 'ac_voltage', label: 'AC Voltage', unit: 'V', color: '#f59e0b' },
  { key: 'ac_frequency', label: 'AC Frequency', unit: 'Hz', color: '#8b5cf6' },
  { key: 'dc_current', label: 'DC Current', unit: 'A', color: '#06b6d4' },
  { key: 'dc_voltage', label: 'DC Voltage', unit: 'V', color: '#ec4899' },
]

const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
  '#14b8a6', '#a855f7',
]

type AnalysisMode = 'site' | 'inverter'

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown): string {
  return safe(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// ── Draggable Metric Chip ───────────────────────────────────────────

function DraggableMetricChip({
  metric,
  onDragStart,
}: {
  metric: MetricDef
  onDragStart: (key: MetricKey) => void
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', metric.key)
        onDragStart(metric.key)
      }}
      className="flex cursor-grab items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-primary hover:bg-primary/5 active:cursor-grabbing"
    >
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: metric.color }}
      />
      {metric.label}
      <span className="text-muted-foreground">({metric.unit})</span>
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────

export default function DeveloperPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)
  const allInverters = useDataStore((s) => s.inverters)
  const granularity = useUIStore((s) => s.granularity)

  const [mode, setMode] = useState<AnalysisMode>('site')
  const [selectedSites, setSelectedSites] = useState<string[]>([])
  const [invSiteId, setInvSiteId] = useState('')
  const [selectedInverters, setSelectedInverters] = useState<string[]>([])
  const [activeMetrics, setActiveMetrics] = useState<MetricKey[]>(['dc_power'])
  const [statsOpen, setStatsOpen] = useState(false)

  // Defaults
  useEffect(() => {
    if (mode === 'site' && selectedSites.length === 0 && allSites.length > 0) {
      setSelectedSites([...allSites])
    }
  }, [mode, allSites, selectedSites.length])

  useEffect(() => {
    if (mode === 'inverter' && !invSiteId && allSites.length > 0) {
      setInvSiteId(allSites[0])
    }
  }, [mode, allSites, invSiteId])

  const siteInverterSerials = useMemo(
    () => allInverters.filter((i) => i.site_id === invSiteId).map((i) => i.serial_number),
    [allInverters, invSiteId]
  )

  // Query
  const querySites = mode === 'site' ? selectedSites : invSiteId ? [invSiteId] : []
  const queryInverters = mode === 'inverter' ? selectedInverters : []

  const { results, isLoading } = useMultiMetricTimeSeries(
    querySites,
    activeMetrics,
    granularity,
    queryInverters
  )

  // Available metrics (not yet in chart)
  const availableMetrics = useMemo(
    () => ALL_METRICS.filter((m) => !activeMetrics.includes(m.key)),
    [activeMetrics]
  )

  // Add metric
  const addMetric = useCallback((key: MetricKey) => {
    setActiveMetrics((prev) => {
      if (prev.includes(key) || prev.length >= 4) return prev
      return [...prev, key]
    })
  }, [])

  // Remove metric
  const removeMetric = useCallback((key: MetricKey) => {
    setActiveMetrics((prev) => prev.filter((k) => k !== key))
  }, [])

  // Drop zone handler
  const dropRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const key = e.dataTransfer.getData('text/plain') as MetricKey
      if (key) addMetric(key)
    },
    [addMetric]
  )

  // Build multi-axis chart
  const chartOption = useMemo((): EChartsOption => {
    if (activeMetrics.length === 0) return {}

    const allBuckets = new Set<string>()
    const seriesData: {
      metricKey: MetricKey
      metricDef: MetricDef
      entity: string
      dataMap: Map<string, number>
    }[] = []

    activeMetrics.forEach((metricKey, mIdx) => {
      const result = results[mIdx]
      const data = result?.data
      if (!data) return

      const metricDef = ALL_METRICS.find((m) => m.key === metricKey)!
      const entityKey = mode === 'site' ? 'site_id' : 'serial_number'

      // Group by entity
      const entityMap = new Map<string, Map<string, number>>()
      for (const row of data) {
        const bucket = String(row.bucket)
        allBuckets.add(bucket)
        const entity = String(row[entityKey])
        const m = entityMap.get(entity) ?? new Map()
        m.set(bucket, safe(row.metric_value))
        entityMap.set(entity, m)
      }

      for (const [entity, dataMap] of entityMap) {
        seriesData.push({ metricKey, metricDef, entity, dataMap })
      }
    })

    if (allBuckets.size === 0) return {}

    const buckets = [...allBuckets].sort()

    // Build y-axes (one per metric, max 2 visible)
    const yAxes = activeMetrics.map((mk, idx) => {
      const def = ALL_METRICS.find((m) => m.key === mk)!
      return {
        type: 'value' as const,
        name: `${def.label} (${def.unit})`,
        nameTextStyle: { fontSize: 10, color: def.color },
        position: idx % 2 === 0 ? ('left' as const) : ('right' as const),
        offset: Math.floor(idx / 2) * 60,
        axisLine: { lineStyle: { color: def.color } },
        axisLabel: { fontSize: 10 },
        splitLine: { show: idx === 0 },
      }
    })

    // Build series
    const series = seriesData.map((sd, idx) => {
      const yAxisIndex = activeMetrics.indexOf(sd.metricKey)
      const entityCount = seriesData.filter((s) => s.metricKey === sd.metricKey).length
      const entityIdx = seriesData.filter(
        (s, i) => i < idx && s.metricKey === sd.metricKey
      ).length

      let color = sd.metricDef.color
      if (entityCount > 1) {
        // Cycle through SERIES_COLORS for the entity within that metric
        color = SERIES_COLORS[entityIdx % SERIES_COLORS.length]
      }

      return {
        name: `${sd.metricDef.label} — ${sd.entity}`,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        yAxisIndex,
        data: buckets.map((b) => sd.dataMap.get(b) ?? null),
        lineStyle: { color, width: 1.5 },
        itemStyle: { color },
      }
    })

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 10 } },
      grid: {
        top: 50,
        right: activeMetrics.length > 2 ? 120 : 60,
        bottom: 70,
        left: activeMetrics.length > 2 ? 120 : 65,
      },
      xAxis: {
        type: 'category',
        data: buckets,
        axisLabel: { rotate: 30, fontSize: 10 },
      },
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', bottom: 5, height: 25 },
      ],
      series,
    }
  }, [activeMetrics, results, mode])

  // Stats table
  const statsData = useMemo(() => {
    const rows: {
      metricKey: MetricKey
      metric: string
      entity: string
      count: number
      mean: number
      max: number
      min: number
      stdDev: number
      sum: number
    }[] = []

    activeMetrics.forEach((metricKey, mIdx) => {
      const result = results[mIdx]
      const data = result?.data
      if (!data) return

      const metricDef = ALL_METRICS.find((m) => m.key === metricKey)!
      const entityKey = mode === 'site' ? 'site_id' : 'serial_number'
      const entityMap = new Map<string, number[]>()

      for (const row of data) {
        const entity = String(row[entityKey])
        const list = entityMap.get(entity) ?? []
        list.push(safe(row.metric_value))
        entityMap.set(entity, list)
      }

      for (const [entity, values] of entityMap) {
        const nonZero = values.filter((v) => v !== 0)
        const sum = nonZero.reduce((a, b) => a + b, 0)
        const mean = nonZero.length > 0 ? sum / nonZero.length : 0
        const max = nonZero.length > 0 ? Math.max(...nonZero) : 0
        const min = nonZero.length > 0 ? Math.min(...nonZero) : 0
        const variance =
          nonZero.length > 0
            ? nonZero.reduce((a, v) => a + (v - mean) ** 2, 0) / nonZero.length
            : 0
        rows.push({
          metricKey: metricKey,
          metric: `${metricDef.label} (${metricDef.unit})`,
          entity,
          count: nonZero.length,
          mean,
          max,
          min,
          stdDev: Math.sqrt(variance),
          sum,
        })
      }
    })

    return rows
  }, [activeMetrics, results, mode])

  // CSV export data
  const exportData = useMemo(
    () => statsData as unknown as Record<string, unknown>[],
    [statsData]
  )

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">
          No data loaded.{' '}
          <a href="#/upload" className="underline text-primary">
            Upload data
          </a>{' '}
          first.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Developer Mode</h1>
        <ExportToolbar
          elementId="developer-content"
          filename="compdash-developer"
          data={exportData}
        />
      </div>

      <div id="developer-content" className="space-y-6">
        {/* Available Parameters — Drag from here */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Available Parameters
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Drag and drop onto the chart area, or click + to add (max 4)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {availableMetrics.map((m) => (
                <DraggableMetricChip
                  key={m.key}
                  metric={m}
                  onDragStart={() => {}}
                />
              ))}
              {availableMetrics.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  All parameters added to chart
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Filters */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-start gap-4">
              <div className="flex gap-1 rounded-lg border p-1">
                <Button
                  variant={mode === 'site' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setMode('site')}
                >
                  By Site
                </Button>
                <Button
                  variant={mode === 'inverter' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setMode('inverter')}
                >
                  By Inverter
                </Button>
              </div>

              {mode === 'site' ? (
                <SiteSelector
                  allSites={allSites}
                  selectedSites={selectedSites}
                  onChange={setSelectedSites}
                />
              ) : (
                <div className="flex flex-wrap items-start gap-3">
                  <Select
                    value={invSiteId}
                    onValueChange={(v) => {
                      if (v) {
                        setInvSiteId(v)
                        setSelectedInverters([])
                      }
                    }}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue placeholder="Select site" />
                    </SelectTrigger>
                    <SelectContent>
                      {allSites.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <InverterSelector
                    serials={siteInverterSerials}
                    selected={selectedInverters}
                    onChange={setSelectedInverters}
                    maxSelect={8}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <DateRangePicker />
              <GranularityToggle />
            </div>
          </CardContent>
        </Card>

        {/* Chart Drop Zone + Active Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Multi-Parameter Chart
              <span className="text-xs font-normal text-muted-foreground">
                {activeMetrics.length} / 4 parameters
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Active metrics chips */}
            <div className="flex flex-wrap items-center gap-2">
              {activeMetrics.map((mk) => {
                const def = ALL_METRICS.find((m) => m.key === mk)!
                return (
                  <Badge key={mk} className="gap-1 pr-1" style={{ backgroundColor: def.color }}>
                    {def.label} ({def.unit})
                    <button
                      className="ml-1 rounded-full p-0.5 hover:bg-white/30"
                      onClick={() => removeMetric(mk)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                )
              })}
              {activeMetrics.length < 4 && availableMetrics.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => addMetric(availableMetrics[0].key)}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              )}
            </div>

            {/* Drop zone / chart */}
            <div
              ref={dropRef}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`relative rounded-lg border-2 border-dashed transition-colors ${
                dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent'
              }`}
            >
              {isLoading ? (
                <div className="flex items-center justify-center py-20 text-muted-foreground">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Loading…
                </div>
              ) : activeMetrics.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Download className="mb-2 h-8 w-8 opacity-40" />
                  <p className="text-sm">
                    Drag a parameter here or click + to start
                  </p>
                </div>
              ) : (
                <LineChart option={chartOption} height={500} />
              )}
            </div>
          </CardContent>
        </Card>

        {/* Collapsible Stats Table */}
        {statsData.length > 0 && (
          <Card>
            <CardHeader
              className="cursor-pointer select-none"
              onClick={() => setStatsOpen((o) => !o)}
            >
              <CardTitle className="flex items-center gap-2 text-base">
                {statsOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                <Table2 className="h-4 w-4" />
                Statistics
                <span className="text-xs font-normal text-muted-foreground">
                  ({statsData.length} rows)
                </span>
              </CardTitle>
            </CardHeader>
            {statsOpen && (
              <CardContent>
                <div className="max-h-[400px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Parameter</TableHead>
                        <TableHead>{mode === 'site' ? 'Site' : 'Inverter'}</TableHead>
                        <TableHead>Data Points</TableHead>
                        <TableHead>Mean</TableHead>
                        <TableHead>Max</TableHead>
                        <TableHead>Min</TableHead>
                        <TableHead>Std Dev</TableHead>
                        <TableHead>Total (Energy only)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statsData.map((s, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-medium text-xs">
                            {s.metric}
                          </TableCell>
                          <TableCell className="text-xs">{s.entity}</TableCell>
                          <TableCell>{s.count.toLocaleString()}</TableCell>
                          <TableCell>{fmt(s.mean)}</TableCell>
                          <TableCell>{fmt(s.max)}</TableCell>
                          <TableCell>{fmt(s.min)}</TableCell>
                          <TableCell>{fmt(s.stdDev)}</TableCell>
                          <TableCell>{s.metricKey === 'energy_produced' ? fmt(s.sum) : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Quick SQL Query (read-only info) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Debug Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>
              <strong>Active metrics:</strong>{' '}
              {activeMetrics.join(', ') || 'none'}
            </p>
            <p>
              <strong>Mode:</strong> {mode}
            </p>
            <p>
              <strong>Granularity:</strong> {granularity}
            </p>
            <p>
              <strong>Sites:</strong>{' '}
              {(mode === 'site' ? selectedSites : [invSiteId]).join(', ')}
            </p>
            {mode === 'inverter' && selectedInverters.length > 0 && (
              <p>
                <strong>Inverters:</strong> {selectedInverters.join(', ')}
              </p>
            )}
            <p>
              <strong>Data queries:</strong> {results.length} (
              {results.filter((r) => r.isSuccess).length} success,{' '}
              {results.filter((r) => r.isLoading).length} loading)
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
