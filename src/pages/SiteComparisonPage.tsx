import { useMemo, useState, useEffect } from 'react'
import { Loader2, Layers, LayoutGrid, ExternalLink } from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { Button } from '@/components/ui/button'
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

const SITE_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
  '#14b8a6', '#a855f7',
]

const METRIC_LABELS: Record<string, string> = {
  dc_power: 'DC Power (W)',
  ac_power: 'AC Power (W)',
  energy_produced: 'Energy (kWh)',
  temperature_c: 'Temperature (°C)',
  ac_voltage: 'AC Voltage (V)',
  ac_frequency: 'AC Frequency (Hz)',
  dc_current: 'DC Current (A)',
  dc_voltage: 'DC Voltage (V)',
}

const METRIC_STAT_LABELS: Record<string, { name: string; unit: string }> = {
  dc_power: { name: 'DC Power', unit: 'W' },
  ac_power: { name: 'AC Power', unit: 'W' },
  energy_produced: { name: 'Energy Produced', unit: 'kWh' },
  temperature_c: { name: 'Temperature', unit: '°C' },
  ac_voltage: { name: 'AC Voltage', unit: 'V' },
  ac_frequency: { name: 'AC Frequency', unit: 'Hz' },
  dc_current: { name: 'DC Current', unit: 'A' },
  dc_voltage: { name: 'DC Voltage', unit: 'V' },
}

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown): string {
  return safe(n).toLocaleString(undefined, { maximumFractionDigits: 1 })
}

export default function SiteComparisonPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)
  const selectedSites = useUIStore((s) => s.selectedSites)
  const setSelectedSites = useUIStore((s) => s.setSelectedSites)
  const granularity = useUIStore((s) => s.granularity)
  const metric = useUIStore((s) => s.metric)

  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>([metric])
  const [chartMode, setChartMode] = useState<'overlay' | 'split'>('overlay')

  // Default: select all sites if none selected
  useEffect(() => {
    if (selectedSites.length === 0 && allSites.length > 0) {
      setSelectedSites([...allSites])
    }
  }, [allSites, selectedSites.length, setSelectedSites])

  const { results: metricResults, isLoading: tsLoading } = useMultiMetricTimeSeries(
    selectedSites,
    selectedMetrics,
    granularity
  )

  const tsData = metricResults[0]?.data as MultiMetricTimeSeriesRow[] | undefined

  // ── Group time series by site ──────────────────────────────────────

  const siteSeriesMap = useMemo(() => {
    if (!tsData) return new Map<string, MultiMetricTimeSeriesRow[]>()
    const map = new Map<string, MultiMetricTimeSeriesRow[]>()
    for (const row of tsData) {
      const list = map.get(row.site_id) ?? []
      list.push(row)
      map.set(row.site_id, list)
    }
    return map
  }, [tsData])

  // ── Summary stats ─────────────────────────────────────────────────

  const summaryStats = useMemo(() => {
    return selectedSites.map((siteId, idx) => {
      const rows = siteSeriesMap.get(siteId) ?? []
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
      const totalEnergy = rows.reduce((a, r) => a + safe(r.metric_value), 0)
      return { siteId, mean, max, min, stdDev, totalEnergy, count: values.length, idx }
    })
  }, [selectedSites, siteSeriesMap])

  const bestSite = useMemo(() => {
    if (summaryStats.length === 0) return ''
    return summaryStats.reduce((best, s) =>
      s.totalEnergy > best.totalEnergy ? s : best
    ).siteId
  }, [summaryStats])

  // ── Chart options ──────────────────────────────────────────

  // Overlay: single chart with multi Y-axes
  const overlayChartOption = useMemo((): EChartsOption => {
    if (selectedMetrics.length === 0) return {}

    const allBuckets = new Set<string>()
    const seriesArr: { metricKey: MetricKey; siteId: string; dataMap: Map<string, number> }[] = []

    selectedMetrics.forEach((m, mIdx) => {
      const data = metricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data) return
      for (const row of data) {
        allBuckets.add(String(row.bucket))
      }
      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        const sMap = grouped.get(row.site_id) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(row.site_id, sMap)
      }
      for (const site of selectedSites) {
        seriesArr.push({ metricKey: m, siteId: site, dataMap: grouped.get(site) ?? new Map() })
      }
    })

    if (allBuckets.size === 0) return {}
    const buckets = [...allBuckets].sort()

    const yAxes = selectedMetrics.map((m, idx) => ({
      type: 'value' as const,
      name: METRIC_LABELS[m] ?? m,
      nameTextStyle: { fontSize: 10 },
      position: idx % 2 === 0 ? ('left' as const) : ('right' as const),
      offset: Math.floor(idx / 2) * 60,
      splitLine: { show: idx === 0 },
    }))

    const series = seriesArr.map((sd, idx) => {
      const yAxisIndex = selectedMetrics.indexOf(sd.metricKey)
      const label = METRIC_LABELS[sd.metricKey] ?? sd.metricKey
      return {
        name: `${label} — ${sd.siteId}`,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        yAxisIndex,
        data: buckets.map((b) => sd.dataMap.get(b) ?? null),
        lineStyle: { color: SITE_COLORS[idx % SITE_COLORS.length], width: 1.5 },
        itemStyle: { color: SITE_COLORS[idx % SITE_COLORS.length] },
      }
    })

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 10 } },
      grid: { top: 50, right: selectedMetrics.length > 2 ? 120 : 60, bottom: 60, left: selectedMetrics.length > 2 ? 120 : 65 },
      xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: yAxes,
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5 }],
      series,
    }
  }, [selectedMetrics, metricResults, selectedSites])

  // Split: one chart per metric
  const splitChartOptions = useMemo((): { metric: MetricKey; option: EChartsOption }[] => {
    return selectedMetrics.map((m, mIdx) => {
      const data = metricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data || data.length === 0) return { metric: m, option: {} }

      const buckets = [...new Set(data.map((r) => String(r.bucket)))].sort()

      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        const sMap = grouped.get(row.site_id) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(row.site_id, sMap)
      }

      const series = selectedSites.map((siteId, idx) => {
        const dataMap = grouped.get(siteId) ?? new Map()
        return {
          name: siteId,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: buckets.map((b) => dataMap.get(b) ?? null),
          lineStyle: { color: SITE_COLORS[idx % SITE_COLORS.length] },
          itemStyle: { color: SITE_COLORS[idx % SITE_COLORS.length] },
        }
      })

      return {
        metric: m,
        option: {
          tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
          legend: { top: 0 },
          grid: { top: 40, right: 20, bottom: 60, left: 60 },
          xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
          yAxis: { type: 'value', name: METRIC_LABELS[m] ?? m },
          dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5 }],
          series,
        } as EChartsOption,
      }
    })
  }, [selectedMetrics, metricResults, selectedSites])

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
        <h1 className="text-3xl font-bold tracking-tight">Site Comparison</h1>
        <ExportToolbar
          elementId="site-comparison-content"
          filename="compdash-site-comparison"
          data={(summaryStats as unknown as Record<string, unknown>[])}
        />
      </div>

      <div id="site-comparison-content">
      {/* Filter bar */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <SiteSelector
            allSites={allSites}
            selectedSites={selectedSites}
            onChange={setSelectedSites}
          />
          <div className="flex flex-wrap items-center gap-4">
            <DateRangePicker />
            <GranularityToggle />
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

      {/* Summary stats table */}
      {summaryStats.length > 0 && !tsLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Data Points</TableHead>
                  <TableHead>Mean {METRIC_STAT_LABELS[selectedMetrics[0]]?.name ?? selectedMetrics[0]} ({METRIC_STAT_LABELS[selectedMetrics[0]]?.unit ?? ''})</TableHead>
                  <TableHead>Max ({METRIC_STAT_LABELS[selectedMetrics[0]]?.unit ?? ''})</TableHead>
                  <TableHead>Min ({METRIC_STAT_LABELS[selectedMetrics[0]]?.unit ?? ''})</TableHead>
                  <TableHead>Std Dev</TableHead>
                  {selectedMetrics[0] === 'energy_produced' && <TableHead>Total ({METRIC_STAT_LABELS[selectedMetrics[0]]?.unit ?? ''})</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaryStats.map((s) => (
                  <TableRow
                    key={s.siteId}
                    className={s.siteId === bestSite ? 'bg-green-50 dark:bg-green-950/30' : ''}
                  >
                    <TableCell className="font-medium">
                      <a
                        href={`https://enlighten.enphaseenergy.com/admin/sites/${s.siteId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                      >
                        {s.siteId}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell>{s.count.toLocaleString()}</TableCell>
                    <TableCell>{fmt(s.mean)}</TableCell>
                    <TableCell>{fmt(s.max)}</TableCell>
                    <TableCell>{fmt(s.min)}</TableCell>
                    <TableCell>{fmt(s.stdDev)}</TableCell>
                    {selectedMetrics[0] === 'energy_produced' && <TableCell>{fmt(s.totalEnergy)}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      {tsLoading ? (
        <Card>
          <CardContent>
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              Loading chart data…
            </div>
          </CardContent>
        </Card>
      ) : chartMode === 'overlay' || selectedMetrics.length === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selectedMetrics.map((m) => METRIC_LABELS[m] ?? m).join(' + ')}
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
              <CardTitle className="text-base">{METRIC_LABELS[m] ?? m}</CardTitle>
            </CardHeader>
            <CardContent>
              <LineChart option={option} height={360} />
            </CardContent>
          </Card>
        ))
      )}
      </div>
    </div>
  )
}
