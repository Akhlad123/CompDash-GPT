import { useMemo, useState, useEffect } from 'react'
import { Loader2, ChevronDown, ChevronRight, Info, MapPin, Cpu, Layers, LayoutGrid } from 'lucide-react'
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import SiteSelector from '@/components/filters/SiteSelector'
import InverterSelector from '@/components/filters/InverterSelector'
import DateRangePicker from '@/components/filters/DateRangePicker'
import GranularityToggle from '@/components/filters/GranularityToggle'
import MultiMetricPicker from '@/components/filters/MultiMetricPicker'
import LineChart from '@/components/charts/LineChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import { useDataStore } from '@/store/dataStore'
import { useUIStore } from '@/store/uiStore'
import { useMultiMetricTimeSeries } from '@/hooks/useMultiMetricTimeSeries'
import type { MultiMetricTimeSeriesRow } from '@/hooks/useMultiMetricTimeSeries'
import type { MetricKey } from '@/lib/queries'

type AnalysisMode = 'site' | 'inverter'

const SERIES_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
]

const METRIC_UNITS: Record<string, string> = {
  dc_power: 'W',
  ac_power: 'W',
  energy_produced: 'kWh',
  temperature_c: '°C',
  ac_voltage: 'V',
  ac_frequency: 'Hz',
  dc_current: 'A',
  dc_voltage: 'V',
}

const METRIC_LABELS: Record<string, string> = {
  dc_power: 'DC Power',
  ac_power: 'AC Power',
  energy_produced: 'Energy Produced',
  temperature_c: 'Temperature',
  ac_voltage: 'AC Voltage',
  ac_frequency: 'AC Frequency',
  dc_current: 'DC Current',
  dc_voltage: 'DC Voltage',
}

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown): string {
  return safe(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function TimeSeriesPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)
  const allInverters = useDataStore((s) => s.inverters)

  const selectedSites = useUIStore((s) => s.selectedSites)
  const setSelectedSites = useUIStore((s) => s.setSelectedSites)
  const granularity = useUIStore((s) => s.granularity)
  const metric = useUIStore((s) => s.metric)

  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>([metric])
  const [mode, setMode] = useState<AnalysisMode>('site')
  const [invSiteIds, setInvSiteIds] = useState<string[]>([])
  const [selectedInverters, setSelectedInverters] = useState<string[]>([])
  const [statsOpen, setStatsOpen] = useState(true)
  const [chartMode, setChartMode] = useState<'overlay' | 'split'>('overlay')

  // Defaults
  useEffect(() => {
    if (mode === 'site' && selectedSites.length === 0 && allSites.length > 0) {
      setSelectedSites([...allSites])
    }
  }, [mode, allSites, selectedSites.length, setSelectedSites])

  useEffect(() => {
    if (mode === 'inverter' && invSiteIds.length === 0 && allSites.length > 0) {
      setInvSiteIds([allSites[0]])
    }
  }, [mode, allSites, invSiteIds.length])

  // Inverters for selected sites
  const siteInverterSerials = useMemo(
    () =>
      allInverters
        .filter((i) => invSiteIds.includes(i.site_id))
        .map((i) => i.serial_number),
    [allInverters, invSiteIds]
  )

  // Query params
  const querySites = mode === 'site' ? selectedSites : invSiteIds
  const queryInverters = mode === 'inverter' ? selectedInverters : []

  const { results: metricResults, isLoading } = useMultiMetricTimeSeries(
    querySites,
    selectedMetrics,
    granularity,
    queryInverters
  )

  const tsData = metricResults[0]?.data as MultiMetricTimeSeriesRow[] | undefined

  // Detect granularity from data
  const detectedGranularity = useMemo(() => {
    if (!tsData || tsData.length < 2) return null
    const buckets = [...new Set(tsData.map((r) => String(r.bucket)))].sort()
    if (buckets.length < 2) return null
    const d1 = new Date(buckets[0]).getTime()
    const d2 = new Date(buckets[1]).getTime()
    const diffMin = (d2 - d1) / 60_000
    if (diffMin <= 5) return '5-min'
    if (diffMin <= 15) return '15-min'
    if (diffMin <= 60) return 'hourly'
    return 'daily+'
  }, [tsData])

  // Group by entity
  const entityKey = mode === 'site' ? 'site_id' : 'serial_number'
  const entities = useMemo(() => {
    if (!tsData) return [] as string[]
    return [...new Set(tsData.map((r) => String(r[entityKey])))]
  }, [tsData, entityKey])

  const entitySeriesMap = useMemo(() => {
    if (!tsData) return new Map<string, MultiMetricTimeSeriesRow[]>()
    const map = new Map<string, MultiMetricTimeSeriesRow[]>()
    for (const row of tsData) {
      const key = String(row[entityKey])
      const list = map.get(key) ?? []
      list.push(row)
      map.set(key, list)
    }
    return map
  }, [tsData, entityKey])

  // Stats
  const stats = useMemo(() => {
    return entities.map((entity) => {
      const rows = entitySeriesMap.get(entity) ?? []
      const values = rows.map((r) => safe(r.metric_value)).filter((v) => v !== 0)
      const sum = values.reduce((a, b) => a + b, 0)
      const mean = values.length > 0 ? sum / values.length : 0
      const max = values.length > 0 ? Math.max(...values) : 0
      const min = values.length > 0 ? Math.min(...values) : 0
      const variance =
        values.length > 0
          ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
          : 0
      const stdDev = Math.sqrt(variance)
      return { entity, mean, max, min, stdDev, sum, count: values.length }
    })
  }, [entities, entitySeriesMap])

  // Overlay: single multi-axis chart
  const overlayChartOption = useMemo((): EChartsOption => {
    if (selectedMetrics.length === 0) return {}

    const allBuckets = new Set<string>()
    const seriesArr: { metricKey: MetricKey; entity: string; dataMap: Map<string, number> }[] = []

    selectedMetrics.forEach((m, mIdx) => {
      const data = metricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data) return
      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        allBuckets.add(String(row.bucket))
        const key = String(row[entityKey])
        const sMap = grouped.get(key) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(key, sMap)
      }
      for (const [entity, dataMap] of grouped) {
        seriesArr.push({ metricKey: m, entity, dataMap })
      }
    })

    if (allBuckets.size === 0) return {}
    const buckets = [...allBuckets].sort()

    const yAxes = selectedMetrics.map((m, idx) => {
      const unit = METRIC_UNITS[m] ?? ''
      const label = METRIC_LABELS[m] ?? m
      return {
        type: 'value' as const,
        name: `${label} (${unit})`,
        nameTextStyle: { fontSize: 10 },
        position: idx % 2 === 0 ? ('left' as const) : ('right' as const),
        offset: Math.floor(idx / 2) * 60,
        splitLine: { show: idx === 0 },
      }
    })

    const series = seriesArr.map((sd, idx) => {
      const yAxisIndex = selectedMetrics.indexOf(sd.metricKey)
      const label = METRIC_LABELS[sd.metricKey] ?? sd.metricKey
      return {
        name: `${label} — ${sd.entity}`,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        yAxisIndex,
        data: buckets.map((b) => sd.dataMap.get(b) ?? null),
        lineStyle: { color: SERIES_COLORS[idx % SERIES_COLORS.length], width: 1.5 },
        itemStyle: { color: SERIES_COLORS[idx % SERIES_COLORS.length] },
      }
    })

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 10 } },
      grid: { top: 50, right: selectedMetrics.length > 2 ? 120 : 60, bottom: 70, left: selectedMetrics.length > 2 ? 120 : 65 },
      xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: yAxes,
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5, height: 25 }],
      series,
    }
  }, [selectedMetrics, metricResults, entityKey])

  // Split: one chart per metric
  const splitChartOptions = useMemo((): { metric: MetricKey; option: EChartsOption }[] => {
    return selectedMetrics.map((m, mIdx) => {
      const data = metricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data || data.length === 0) return { metric: m, option: {} }

      const buckets = [...new Set(data.map((r) => String(r.bucket)))].sort()
      const unit = METRIC_UNITS[m] ?? ''
      const label = METRIC_LABELS[m] ?? m

      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        const key = String(row[entityKey])
        const sMap = grouped.get(key) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(key, sMap)
      }
      const entitiesForMetric = [...grouped.keys()]

      const series = entitiesForMetric.map((entity, idx) => {
        const dataMap = grouped.get(entity) ?? new Map()
        const values = [...dataMap.values()]
        const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0

        return {
          name: entity,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: buckets.map((b) => dataMap.get(b) ?? null),
          lineStyle: { color: SERIES_COLORS[idx % SERIES_COLORS.length] },
          itemStyle: { color: SERIES_COLORS[idx % SERIES_COLORS.length] },
          markLine: {
            silent: true,
            data: [
              {
                yAxis: mean,
                lineStyle: {
                  color: SERIES_COLORS[idx % SERIES_COLORS.length],
                  type: 'dashed' as const,
                  width: 1,
                  opacity: 0.6,
                },
                label: { formatter: `μ ${fmt(mean)}`, fontSize: 9 },
              },
            ],
          },
        }
      })

      return {
        metric: m,
        option: {
          tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
          legend: { top: 0 },
          grid: { top: 40, right: 20, bottom: 70, left: 65 },
          xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
          yAxis: { type: 'value', name: `${label} (${unit})`, nameTextStyle: { fontSize: 11 } },
          dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5, height: 25 }],
          series,
        } as EChartsOption,
      }
    })
  }, [selectedMetrics, metricResults, entityKey])

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">No data loaded. <a href="#/upload" className="underline text-primary">Upload data</a> first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Time Series</h1>
        <ExportToolbar
          elementId="timeseries-content"
          filename="compdash-timeseries"
          data={(stats as unknown as Record<string, unknown>[])}
        />
      </div>

      <div id="timeseries-content">
      {/* Filter bar */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* Mode + entity selectors */}
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex gap-1 rounded-lg border p-1">
              <Button
                variant={mode === 'site' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setMode('site')}
              >
                <MapPin className="mr-1 h-3.5 w-3.5" />
                By Site
              </Button>
              <Button
                variant={mode === 'inverter' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setMode('inverter')}
              >
                <Cpu className="mr-1 h-3.5 w-3.5" />
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
                <SiteSelector
                  allSites={allSites}
                  selectedSites={invSiteIds}
                  onChange={(sites) => {
                    setInvSiteIds(sites)
                    setSelectedInverters([])
                  }}
                />
                <InverterSelector
                  serials={siteInverterSerials}
                  selected={selectedInverters}
                  onChange={setSelectedInverters}
                  maxSelect={8}
                />
              </div>
            )}
          </div>

          {/* Other filters */}
          <div className="flex flex-wrap items-center gap-4">
            <DateRangePicker />
            <GranularityToggle />
            {detectedGranularity && (
              <Badge variant="secondary" className="gap-1">
                <Info className="h-3 w-3" />
                Detected: {detectedGranularity}
              </Badge>
            )}
            {selectedMetrics.length > 1 && (
              <div className="ml-auto flex gap-1 rounded-lg border p-1">
                <Button
                  variant={chartMode === 'overlay' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setChartMode('overlay')}
                >
                  <Layers className="mr-1 h-3.5 w-3.5" />
                  Overlay
                </Button>
                <Button
                  variant={chartMode === 'split' ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setChartMode('split')}
                >
                  <LayoutGrid className="mr-1 h-3.5 w-3.5" />
                  Split
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Multi-metric picker */}
      <MultiMetricPicker selected={selectedMetrics} onChange={setSelectedMetrics} max={4} />

      {/* Charts */}
      {isLoading ? (
        <Card>
          <CardContent>
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading time series…
            </div>
          </CardContent>
        </Card>
      ) : entities.length === 0 ? (
        <Card>
          <CardContent>
            <p className="py-16 text-center text-sm text-muted-foreground">
              {mode === 'inverter'
                ? 'Select at least one inverter above.'
                : 'No data for the selected sites.'}
            </p>
          </CardContent>
        </Card>
      ) : chartMode === 'overlay' || selectedMetrics.length === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selectedMetrics.map((m) => METRIC_LABELS[m] ?? m).join(' + ')} — {mode === 'site' ? 'By Site' : 'By Inverter'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <LineChart option={selectedMetrics.length === 1 ? (splitChartOptions[0]?.option ?? {}) : overlayChartOption} height={420} />
          </CardContent>
        </Card>
      ) : (
        splitChartOptions.map(({ metric: m, option }) => (
          <Card key={m}>
            <CardHeader>
              <CardTitle className="text-base">
                {METRIC_LABELS[m] ?? m} — {mode === 'site' ? 'By Site' : 'By Inverter'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <LineChart option={option} height={400} />
            </CardContent>
          </Card>
        ))
      )}

      {/* Collapsible stats panel */}
      {stats.length > 0 && (
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
              Statistics
            </CardTitle>
          </CardHeader>
          {statsOpen && (
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{mode === 'site' ? 'Site' : 'Inverter'}</TableHead>
                    <TableHead>Data Points</TableHead>
                    <TableHead>Mean</TableHead>
                    <TableHead>Max</TableHead>
                    <TableHead>Min</TableHead>
                    <TableHead>Std Dev</TableHead>
                    {selectedMetrics[0] === 'energy_produced' && <TableHead>Total (kWh)</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.map((s) => (
                    <TableRow key={s.entity}>
                      <TableCell className="font-medium">{s.entity}</TableCell>
                      <TableCell>{s.count.toLocaleString()}</TableCell>
                      <TableCell>{fmt(s.mean)}</TableCell>
                      <TableCell>{fmt(s.max)}</TableCell>
                      <TableCell>{fmt(s.min)}</TableCell>
                      <TableCell>{fmt(s.stdDev)}</TableCell>
                      {selectedMetrics[0] === 'energy_produced' && <TableCell>{fmt(s.sum)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          )}
        </Card>
      )}
      </div>
    </div>
  )
}
