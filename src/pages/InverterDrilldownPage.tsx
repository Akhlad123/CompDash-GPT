import { useMemo, useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, Loader2, ExternalLink, Plus, Trash2, Layers, LayoutGrid } from 'lucide-react'
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import DateRangePicker from '@/components/filters/DateRangePicker'
import InverterSelector from '@/components/filters/InverterSelector'
import LineChart from '@/components/charts/LineChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import SiteContextPanel from '@/components/fleet/SiteContextPanel'
import { useDataStore } from '@/store/dataStore'
import { useUIStore } from '@/store/uiStore'
import { useInverterStats } from '@/hooks/useInverterStats'
import { useMultiMetricTimeSeries } from '@/hooks/useMultiMetricTimeSeries'
import type { MultiMetricTimeSeriesRow } from '@/hooks/useMultiMetricTimeSeries'
import { query as duckQuery } from '@/lib/duckdb'
import { buildDateFilter } from '@/lib/queries'
import type { MetricKey } from '@/lib/queries'
import type { InverterStatsWithZ, InverterStatus } from '@/hooks/useInverterStats'
import MultiMetricPicker from '@/components/filters/MultiMetricPicker'

const METRIC_LABELS: Record<string, string> = {
  dc_power: 'DC Power (W)',
  ac_power: 'AC Power (W)',
  energy_produced: 'Energy (kWh)',
  temperature_c: 'Temperature (\u00b0C)',
  ac_voltage: 'AC Voltage (V)',
  ac_frequency: 'AC Frequency (Hz)',
  dc_current: 'DC Current (A)',
  dc_voltage: 'DC Voltage (V)',
}

const STATUS_VARIANTS: Record<InverterStatus, 'default' | 'secondary' | 'destructive'> = {
  normal: 'default',
  warning: 'secondary',
  alert: 'destructive',
}

type SortKey = keyof Pick<
  InverterStatsWithZ,
  | 'serial_number'
  | 'total_energy'
  | 'avg_dc_power'
  | 'avg_temperature'
  | 'row_count'
  | 'z_score'
>

interface ThresholdResultRow {
  serial_number: string
  sku_name: string | null
  total_energy_kwh: number
  energy_above_kwh: number
  energy_below_kwh: number
  pct_energy: number
  data_points_above: number
  data_points_below: number
  total_data_points: number
}

interface ThresholdCondition {
  id: string
  parameter: ThresholdParam
  threshold: string
}

type ThresholdParam = 'dc_power' | 'ac_power' | 'ac_voltage' | 'ac_frequency' | 'temperature_c' | 'dc_current' | 'dc_voltage'

const THRESHOLD_PARAMS: { value: ThresholdParam; label: string; unit: string; expr: string }[] = [
  { value: 'dc_power', label: 'DC Power', unit: 'W', expr: 'dc_current * dc_voltage' },
  { value: 'ac_power', label: 'AC Power', unit: 'W', expr: 'CASE WHEN duration > 0 THEN (energy_produced * 3600.0) / duration ELSE 0 END' },
  { value: 'ac_voltage', label: 'AC Voltage', unit: 'V', expr: 'ac_voltage' },
  { value: 'ac_frequency', label: 'AC Frequency', unit: 'Hz', expr: 'ac_frequency' },
  { value: 'temperature_c', label: 'Temperature', unit: '°C', expr: '(temperature_f - 32) * 5.0 / 9.0' },
  { value: 'dc_current', label: 'DC Current', unit: 'A', expr: 'dc_current' },
  { value: 'dc_voltage', label: 'DC Voltage', unit: 'V', expr: 'dc_voltage' },
]

let nextConditionId = 1

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown): string {
  return safe(n).toLocaleString(undefined, { maximumFractionDigits: 1 })
}

const OVERLAY_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b']

export default function InverterDrilldownPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)
  const granularity = useUIStore((s) => s.granularity)
  const metric = useUIStore((s) => s.metric)

  const dateRange = useDataStore((s) => s.dateRange)

  const [siteId, setSiteId] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('total_energy')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [compareSerials, setCompareSerials] = useState<string[]>([])
  const [detailMetrics, setDetailMetrics] = useState<MetricKey[]>([metric])
  const [crossSiteCompare, setCrossSiteCompare] = useState(false)
  const [compareSiteId, setCompareSiteId] = useState('')
  const [detailChartMode, setDetailChartMode] = useState<'overlay' | 'split'>('overlay')

  const [thresholdConditions, setThresholdConditions] = useState<ThresholdCondition[]>([
    { id: String(nextConditionId++), parameter: 'dc_power', threshold: '' },
  ])
  const [thresholdLogic, setThresholdLogic] = useState<'AND' | 'OR'>('AND')
  const [thresholdDirection, setThresholdDirection] = useState<'below' | 'above'>('above')

  const [searchParams] = useSearchParams()

  // Default site — deep-link ?site=<id> (e.g. cross-linked from Fleet QueryPage)
  // takes precedence over the first-site fallback.
  useEffect(() => {
    if (allSites.length === 0) return
    const urlSite = searchParams.get('site')
    if (urlSite && allSites.includes(urlSite)) {
      setSiteId(urlSite)
    } else if (!siteId) {
      setSiteId(allSites[0])
    }
  }, [allSites, searchParams, siteId])

  const { data: stats, isLoading } = useInverterStats(siteId)

  // Threshold analysis helpers
  const addCondition = useCallback(() => {
    setThresholdConditions((prev) => [
      ...prev,
      { id: String(nextConditionId++), parameter: 'dc_power', threshold: '' },
    ])
  }, [])

  const removeCondition = useCallback((id: string) => {
    setThresholdConditions((prev) => prev.length > 1 ? prev.filter((c) => c.id !== id) : prev)
  }, [])

  const updateCondition = useCallback((id: string, field: 'parameter' | 'threshold', value: string) => {
    setThresholdConditions((prev) =>
      prev.map((c) => c.id === id ? { ...c, [field]: value } : c)
    )
  }, [])

  const thresholdValid = useMemo(() => {
    return thresholdConditions.every((c) => {
      const num = Number(c.threshold)
      return c.threshold !== '' && Number.isFinite(num)
    })
  }, [thresholdConditions])

  const { data: thresholdData } = useQuery<ThresholdResultRow[]>({
    queryKey: ['threshold', siteId, thresholdConditions, thresholdLogic, thresholdDirection, dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      const df = buildDateFilter(dateRange)
      const sf = siteId && siteId !== '__all__' ? `site_id = '${siteId}'` : '1=1'

      if (thresholdDirection === 'above') {
        // ABOVE: For rows where param > threshold, compute marginal energy:
        //   energy_above = SUM( (param - threshold) * duration / 3600 ) / 1000  [kWh]
        // Use the first condition's param expression & threshold for energy calc.
        // The combined WHERE filters which rows qualify.
        const aboveConditions = thresholdConditions.map((c) => {
          const param = THRESHOLD_PARAMS.find((p) => p.value === c.parameter)
          const expr = param?.expr ?? c.parameter
          return `(${expr}) > ${Number(c.threshold)}`
        })
        const aboveWhere = aboveConditions.join(thresholdLogic === 'AND' ? ' AND ' : ' OR ')

        // Use first condition for energy calculation
        const primaryParam = THRESHOLD_PARAMS.find((p) => p.value === thresholdConditions[0].parameter)
        const primaryExpr = primaryParam?.expr ?? thresholdConditions[0].parameter
        const primaryThreshold = Number(thresholdConditions[0].threshold)

        // energy_above = SUM( (param_value - threshold) * duration / 3600 ) / 1000
        const energyAboveExpr = `SUM(CASE WHEN ${aboveWhere} THEN ((${primaryExpr}) - ${primaryThreshold}) * COALESCE(duration, 0) / 3600.0 / 1000.0 ELSE 0 END)`

        const sql = `
          SELECT
            serial_number,
            sku_name,
            SUM(energy_produced) / 1000.0 AS total_energy_kwh,
            GREATEST(${energyAboveExpr}, 0) AS energy_above_kwh,
            GREATEST(SUM(energy_produced) / 1000.0 - GREATEST(${energyAboveExpr}, 0), 0) AS energy_below_kwh,
            CASE WHEN SUM(energy_produced) > 0
              THEN LEAST(GREATEST(${energyAboveExpr}, 0) / (SUM(energy_produced) / 1000.0) * 100, 100)
              ELSE 0 END AS pct_energy,
            SUM(CASE WHEN ${aboveWhere} THEN 1 ELSE 0 END) AS data_points_above,
            COUNT(*) - SUM(CASE WHEN ${aboveWhere} THEN 1 ELSE 0 END) AS data_points_below,
            COUNT(*) AS total_data_points
          FROM telemetry
          WHERE ${sf} ${df}
          GROUP BY serial_number, sku_name
          ORDER BY energy_above_kwh DESC
        `
        return duckQuery<ThresholdResultRow>(sql)
      } else {
        // BELOW: find DAYS where the parameter NEVER crossed the threshold,
        // then sum energy and data points for those days only.
        // Step 1: per (serial, day), compute MAX of each param expression
        // Step 2: filter to days where MAX < threshold (param never crossed it)
        // Step 3: aggregate energy for qualifying days per serial

        const belowConditions = thresholdConditions.map((c) => {
          return `max_${c.parameter} < ${Number(c.threshold)}`
        })
        const belowWhere = belowConditions.join(thresholdLogic === 'AND' ? ' AND ' : ' OR ')

        const maxExprs = thresholdConditions.map((c) => {
          const param = THRESHOLD_PARAMS.find((p) => p.value === c.parameter)
          const expr = param?.expr ?? c.parameter
          return `MAX(${expr}) AS max_${c.parameter}`
        }).join(', ')

        const sql = `
          WITH daily AS (
            SELECT
              serial_number,
              sku_name,
              CAST(timestamp AS DATE) AS day,
              SUM(energy_produced) / 1000.0 AS day_energy_kwh,
              COUNT(*) AS day_points,
              ${maxExprs}
            FROM telemetry
            WHERE ${sf} ${df}
            GROUP BY serial_number, sku_name, CAST(timestamp AS DATE)
          ),
          totals AS (
            SELECT
              serial_number,
              sku_name,
              SUM(energy_produced) / 1000.0 AS total_energy_kwh,
              COUNT(*) AS total_data_points
            FROM telemetry
            WHERE ${sf} ${df}
            GROUP BY serial_number, sku_name
          )
          SELECT
            t.serial_number,
            t.sku_name,
            t.total_energy_kwh,
            t.total_energy_kwh - COALESCE(SUM(d.day_energy_kwh), 0) AS energy_above_kwh,
            COALESCE(SUM(d.day_energy_kwh), 0) AS energy_below_kwh,
            CASE WHEN t.total_energy_kwh > 0
              THEN COALESCE(SUM(d.day_energy_kwh), 0) / t.total_energy_kwh * 100
              ELSE 0 END AS pct_energy,
            t.total_data_points - COALESCE(SUM(d.day_points), 0) AS data_points_above,
            COALESCE(SUM(d.day_points), 0) AS data_points_below,
            t.total_data_points
          FROM totals t
          LEFT JOIN daily d ON t.serial_number = d.serial_number AND t.sku_name IS NOT DISTINCT FROM d.sku_name AND (${belowWhere})
          GROUP BY t.serial_number, t.sku_name, t.total_energy_kwh, t.total_data_points
          ORDER BY energy_below_kwh DESC
        `
        return duckQuery<ThresholdResultRow>(sql)
      }
    },
    enabled: isDataLoaded && siteId.length > 0 && thresholdValid,
  })

  // Filter + sort
  const filtered = useMemo(() => {
    if (!stats) return []
    const term = searchTerm.toLowerCase()
    return stats.filter((r) => {
      if (!term) return true
      return (
        r.serial_number.toLowerCase().includes(term) ||
        (r.sku_name?.toLowerCase().includes(term) ?? false)
      )
    })
  }, [stats, searchTerm])

  const sorted = useMemo(() => {
    const rows = [...filtered]
    rows.sort((a, b) => {
      const aVal = a[sortKey]
      const bVal = b[sortKey]
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      const aNum = typeof aVal === 'number' ? aVal : 0
      const bNum = typeof bVal === 'number' ? bVal : 0
      return sortDir === 'asc' ? aNum - bNum : bNum - aNum
    })
    return rows
  }, [filtered, sortKey, sortDir])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else { setSortKey(key); setSortDir('desc') }
    },
    [sortKey]
  )

  // Detail panel: time series for selected inverters
  const activeSerials = useMemo(() => {
    if (compareSerials.length > 0) return compareSerials
    if (selectedSerial) return [selectedSerial]
    return []
  }, [compareSerials, selectedSerial])

  // Determine which sites to query for detail charts
  const detailSiteIds = useMemo(() => {
    const sites = new Set<string>()
    if (siteId) sites.add(siteId)
    if (crossSiteCompare && compareSiteId) sites.add(compareSiteId)
    return [...sites]
  }, [siteId, crossSiteCompare, compareSiteId])

  const { results: detailMetricResults, isLoading: tsLoading } = useMultiMetricTimeSeries(
    detailSiteIds,
    detailMetrics,
    granularity,
    activeSerials
  )

  // Overlay chart for detail panel
  const detailOverlayOption = useMemo((): EChartsOption => {
    if (detailMetrics.length === 0) return {}

    const allBuckets = new Set<string>()
    const seriesArr: { metricKey: MetricKey; serial: string; dataMap: Map<string, number> }[] = []

    detailMetrics.forEach((m, mIdx) => {
      const data = detailMetricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data) return
      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        allBuckets.add(String(row.bucket))
        const sMap = grouped.get(row.serial_number) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(row.serial_number, sMap)
      }
      for (const [serial, dataMap] of grouped) {
        seriesArr.push({ metricKey: m, serial, dataMap })
      }
    })

    if (allBuckets.size === 0) return {}
    const buckets = [...allBuckets].sort()

    const yAxes = detailMetrics.map((m, idx) => ({
      type: 'value' as const,
      name: METRIC_LABELS[m] ?? m,
      nameTextStyle: { fontSize: 10 },
      position: idx % 2 === 0 ? ('left' as const) : ('right' as const),
      offset: Math.floor(idx / 2) * 60,
      splitLine: { show: idx === 0 },
    }))

    const series = seriesArr.map((sd, idx) => {
      const yAxisIndex = detailMetrics.indexOf(sd.metricKey)
      const label = METRIC_LABELS[sd.metricKey] ?? sd.metricKey
      return {
        name: `${label} — ${sd.serial}`,
        type: 'line' as const,
        smooth: true,
        symbol: 'none',
        yAxisIndex,
        data: buckets.map((b) => sd.dataMap.get(b) ?? null),
        lineStyle: { color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length], width: 1.5 },
        itemStyle: { color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length] },
      }
    })

    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 10 } },
      grid: { top: 50, right: detailMetrics.length > 2 ? 120 : 60, bottom: 50, left: detailMetrics.length > 2 ? 120 : 55 },
      xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
      yAxis: yAxes,
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5 }],
      series,
    }
  }, [detailMetrics, detailMetricResults])

  // Split charts for detail panel
  const detailSplitOptions = useMemo((): { metric: MetricKey; option: EChartsOption }[] => {
    return detailMetrics.map((m, mIdx) => {
      const data = detailMetricResults[mIdx]?.data as MultiMetricTimeSeriesRow[] | undefined
      if (!data || data.length === 0) return { metric: m, option: {} }

      const buckets = [...new Set(data.map((r) => String(r.bucket)))].sort()
      const grouped = new Map<string, Map<string, number>>()
      for (const row of data) {
        const sMap = grouped.get(row.serial_number) ?? new Map()
        sMap.set(String(row.bucket), safe(row.metric_value))
        grouped.set(row.serial_number, sMap)
      }

      const series = activeSerials.map((serial, idx) => {
        const dataMap = grouped.get(serial) ?? new Map()
        return {
          name: serial,
          type: 'line' as const,
          smooth: true,
          symbol: 'none',
          data: buckets.map((b) => dataMap.get(b) ?? null),
          lineStyle: { color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length] },
          itemStyle: { color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length] },
        }
      })

      return {
        metric: m,
        option: {
          tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
          legend: { top: 0 },
          grid: { top: 35, right: 20, bottom: 50, left: 55 },
          xAxis: { type: 'category', data: buckets, axisLabel: { rotate: 30, fontSize: 10 } },
          yAxis: { type: 'value', name: METRIC_LABELS[m] ?? m },
          dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 5 }],
          series,
        } as EChartsOption,
      }
    })
  }, [detailMetrics, detailMetricResults, activeSerials])

  // Selected inverter info
  const selectedInfo = useMemo(
    () => stats?.find((r) => r.serial_number === selectedSerial) ?? null,
    [stats, selectedSerial]
  )

  const siteSerials = useMemo(
    () => filtered.map((r) => r.serial_number),
    [filtered]
  )

  const allInverters = useDataStore((s) => s.inverters)
  const compareSiteSerials = useMemo(
    () => allInverters.filter((i) => i.site_id === compareSiteId).map((i) => i.serial_number),
    [allInverters, compareSiteId]
  )

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">No data loaded. <a href="#/upload" className="underline text-primary">Upload data</a> first.</p>
      </div>
    )
  }

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => handleSort(field)}
    >
      {label}
      {sortKey === field && (
        <span className="ml-1 text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </TableHead>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Inverter Drilldown</h1>
        <ExportToolbar
          elementId="inverter-drilldown-content"
          filename="compdash-inverter-drilldown"
          data={(sorted as unknown as Record<string, unknown>[])}
        />
      </div>

      <div id="inverter-drilldown-content">
      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-6">
          <Select
            value={siteId}
            onValueChange={(v) => {
              if (v) {
                setSiteId(v)
                setSelectedSerial(null)
                setCompareSerials([])
              }
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">
                All Sites ({allSites.length})
              </SelectItem>
              {allSites.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DateRangePicker />

          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search serial / SKU…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 rounded-md border border-input bg-transparent pl-8 pr-3 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Inverter Summary Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Inverter Summary — {siteId === '__all__' ? 'All Sites' : siteId}
            {filtered.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({filtered.length} inverters)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortHeader label="Serial Number" field="serial_number" />
                      <TableHead>SKU</TableHead>
                      <SortHeader label="Energy (kWh)" field="total_energy" />
                      <SortHeader label="DC Power (W)" field="avg_dc_power" />
                      <SortHeader label="Temp (°C)" field="avg_temperature" />
                      <SortHeader label="Data Points" field="row_count" />
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((inv) => (
                      <TableRow
                        key={inv.serial_number}
                        className={`cursor-pointer ${
                          inv.serial_number === selectedSerial
                            ? 'bg-primary/5'
                            : 'hover:bg-muted/50'
                        }`}
                        onClick={() => {
                          setSelectedSerial(inv.serial_number)
                          setCompareSerials([inv.serial_number])
                        }}
                      >
                        <TableCell className="font-mono text-xs">
                          {inv.serial_number}
                        </TableCell>
                        <TableCell className="text-xs">
                          {inv.sku_name ?? '—'}
                        </TableCell>
                        <TableCell>{fmt(safe(inv.total_energy) / 1000)}</TableCell>
                        <TableCell>{fmt(inv.avg_dc_power)}</TableCell>
                        <TableCell>{fmt(inv.avg_temperature)}</TableCell>
                        <TableCell>{safe(inv.row_count).toLocaleString()}</TableCell>
                        <TableCell>
                          {inv.status !== 'normal' ? (
                            <Tooltip>
                              <TooltipTrigger>
                                <Badge variant={STATUS_VARIANTS[inv.status]} className="cursor-help">
                                  {inv.status === 'warning' ? 'Warning' : 'Alert'}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-xs text-xs">
                                {inv.reason}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Badge variant={STATUS_VARIANTS[inv.status]}>Normal</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail panel */}
      {selectedSerial && selectedInfo && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-base">
              <span className="font-mono">{selectedInfo.serial_number}</span>
              {selectedInfo.sku_name && (
                <Badge variant="secondary">{selectedInfo.sku_name}</Badge>
              )}
              <a
                href={`https://enlighten.enphaseenergy.com/admin/sites/${selectedInfo.site_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-normal text-primary underline-offset-4 hover:underline"
              >
                Site: {selectedInfo.site_id}
                <ExternalLink className="h-3 w-3" />
              </a>
              <Badge variant={STATUS_VARIANTS[selectedInfo.status]} className="ml-auto">
                Z-score: {safe(selectedInfo.z_score).toFixed(2)} · {selectedInfo.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SiteContextPanel siteId={selectedInfo.site_id} />
            <div className="flex flex-wrap items-center gap-4">
              <InverterSelector
                serials={siteSerials}
                selected={compareSerials}
                onChange={setCompareSerials}
                maxSelect={8}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant={crossSiteCompare ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setCrossSiteCompare((p) => !p)
                  if (!compareSiteId && allSites.length > 1) {
                    setCompareSiteId(allSites.find((s) => s !== siteId) ?? '')
                  }
                }}
              >
                Compare across sites
              </Button>
              {crossSiteCompare && (
                <>
                  <Select
                    value={compareSiteId}
                    onValueChange={(v) => { if (v) setCompareSiteId(v) }}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue placeholder="Pick site" />
                    </SelectTrigger>
                    <SelectContent>
                      {allSites.filter((s) => s !== siteId).map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {compareSiteSerials.length > 0 && (
                    <InverterSelector
                      serials={compareSiteSerials}
                      selected={compareSerials}
                      onChange={setCompareSerials}
                      maxSelect={8}
                    />
                  )}
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <MultiMetricPicker selected={detailMetrics} onChange={setDetailMetrics} max={4} />
              {detailMetrics.length > 1 && (
                <div className="flex gap-1 rounded-lg border p-1">
                  <Button
                    variant={detailChartMode === 'overlay' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setDetailChartMode('overlay')}
                  >
                    <Layers className="mr-1 h-3.5 w-3.5" />
                    Overlay
                  </Button>
                  <Button
                    variant={detailChartMode === 'split' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setDetailChartMode('split')}
                  >
                    <LayoutGrid className="mr-1 h-3.5 w-3.5" />
                    Split
                  </Button>
                </div>
              )}
            </div>

            {tsLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
              </div>
            ) : detailChartMode === 'overlay' || detailMetrics.length === 1 ? (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">
                  {detailMetrics.map((m) => METRIC_LABELS[m] ?? m).join(' + ')}
                </p>
                <LineChart option={detailMetrics.length === 1 ? (detailSplitOptions[0]?.option ?? {}) : detailOverlayOption} height={360} />
              </div>
            ) : (
              <div className="space-y-4">
                {detailSplitOptions.map(({ metric: m, option }) => (
                  <div key={m}>
                    <p className="mb-1 text-sm font-medium text-muted-foreground">{METRIC_LABELS[m] ?? m}</p>
                    <LineChart option={option} height={320} />
                  </div>
                ))}
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedSerial(null)
                setCompareSerials([])
              }}
            >
              Close Detail
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Threshold Analysis */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Threshold Analysis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Show energy</span>
            <div className="flex gap-1 rounded-lg border p-1">
              <Button
                variant={thresholdDirection === 'above' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setThresholdDirection('above')}
              >
                Above
              </Button>
              <Button
                variant={thresholdDirection === 'below' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setThresholdDirection('below')}
              >
                Below
              </Button>
            </div>
            {thresholdConditions.length > 1 && (
              <>
                <span className="text-sm text-muted-foreground">Combine with</span>
                <div className="flex gap-1 rounded-lg border p-1">
                  <Button
                    variant={thresholdLogic === 'AND' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setThresholdLogic('AND')}
                  >
                    AND
                  </Button>
                  <Button
                    variant={thresholdLogic === 'OR' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setThresholdLogic('OR')}
                  >
                    OR
                  </Button>
                </div>
              </>
            )}
          </div>

          {thresholdConditions.map((cond) => {
            const paramInfo = THRESHOLD_PARAMS.find((p) => p.value === cond.parameter)
            return (
              <div key={cond.id} className="flex flex-wrap items-center gap-2">
                <Select
                  value={cond.parameter}
                  onValueChange={(v) => { if (v) updateCondition(cond.id, 'parameter', v) }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THRESHOLD_PARAMS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder={`Enter ${paramInfo?.label ?? ''} threshold…`}
                  value={cond.threshold}
                  onChange={(e) => updateCondition(cond.id, 'threshold', e.target.value)}
                  className="w-48"
                />
                <span className="text-sm text-muted-foreground">{paramInfo?.unit ?? ''}</span>
                {thresholdConditions.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => removeCondition(cond.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                )}
              </div>
            )
          })}

          <Button variant="outline" size="sm" onClick={addCondition} className="gap-1">
            <Plus className="h-3.5 w-3.5" /> Add Condition
          </Button>

          {thresholdValid && thresholdData && thresholdData.length > 0 && (
            <div className="max-h-[400px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Inverter Serial Number</TableHead>
                    <TableHead>SKU / Product Name</TableHead>
                    <TableHead>Data Points {thresholdDirection === 'above' ? 'Above' : 'Below'} / Total</TableHead>
                    <TableHead>Total Energy (kWh)</TableHead>
                    <TableHead>Energy {thresholdDirection === 'above' ? 'Above' : 'Below'} Threshold (kWh)</TableHead>
                    <TableHead>% of Total Energy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {thresholdData.map((row) => {
                    const displayEnergy = thresholdDirection === 'above'
                      ? safe(row.energy_above_kwh)
                      : safe(row.total_energy_kwh) - safe(row.energy_above_kwh)
                    const displayPct = safe(row.total_energy_kwh) > 0
                      ? (Math.abs(displayEnergy) / safe(row.total_energy_kwh)) * 100
                      : 0
                    const displayDataPoints = thresholdDirection === 'above'
                      ? safe(row.data_points_above)
                      : safe(row.data_points_below)
                    return (
                      <TableRow key={row.serial_number}>
                        <TableCell className="font-mono text-xs">{row.serial_number}</TableCell>
                        <TableCell className="text-xs">{row.sku_name ?? '—'}</TableCell>
                        <TableCell>{displayDataPoints.toLocaleString()} / {safe(row.total_data_points).toLocaleString()}</TableCell>
                        <TableCell>{safe(row.total_energy_kwh).toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
                        <TableCell>{Math.abs(displayEnergy).toLocaleString(undefined, { maximumFractionDigits: 2 })}</TableCell>
                        <TableCell>{displayPct.toFixed(1)}%</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {thresholdValid && thresholdData && thresholdData.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No data found for the specified threshold conditions.
            </p>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}
