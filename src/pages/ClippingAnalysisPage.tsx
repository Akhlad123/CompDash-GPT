import { useMemo, useState, useCallback, useEffect } from 'react'
import {
  Scissors, Zap, Gauge, Clock, AlertTriangle, Loader2, ArrowUpDown, ExternalLink, X, TrendingUp,
  ChevronLeft, ChevronRight,
} from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import SiteSelector from '@/components/filters/SiteSelector'
import DateRangePicker from '@/components/filters/DateRangePicker'
import LineChart from '@/components/charts/LineChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import SiteContextPanel from '@/components/fleet/SiteContextPanel'
import VICurveDialog from '@/components/charts/VICurveDialog'
import { useDataStore } from '@/store/dataStore'
import { useClippingAnalysis } from '@/hooks/useClippingAnalysis'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useMultiSiteFleetInfo } from '@/hooks/useMultiSiteFleetInfo'
import { DEFAULT_CLIPPING_OPTIONS } from '@/lib/clippingAnalysis'
import { DEFAULT_MODULE_SPEC, findModuleSpec } from '@/lib/moduleSpecs'
import type { ModuleSpec } from '@/lib/moduleSpecs'
import type { ClippingEvent, ClippingOptions, ClippingType } from '@/lib/clippingAnalysis'
import type { FleetSiteInfo } from '@/hooks/useSiteFleetInfo'

type SortKey = 'site_id' | 'serial_number' | 'date' | 'duration_hours' | 'clipped_value'

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown, decimals = 1): string {
  return safe(n).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtHour(h: string): string {
  try {
    const d = new Date(h)
    if (Number.isNaN(d.getTime())) return h
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return h
  }
}

function fmtHourShort(h: string): string {
  try {
    const d = new Date(h)
    if (Number.isNaN(d.getTime())) return h
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return h
  }
}

const TYPE_COLORS: Record<ClippingType, string> = {
  power: '#ef4444',
  current: '#3b82f6',
}

/** Build a ModuleSpec from fleet data for the VI curve dialog */
function buildModuleSpec(fleetRow: FleetSiteInfo | undefined): ModuleSpec | null {
  if (!fleetRow) return null
  const voc = Number(fleetRow.voc)
  const isc = Number(fleetRow.isc)
  if (!Number.isFinite(voc) || !Number.isFinite(isc) || voc <= 0 || isc <= 0) return null
  // Try name-based lookup first (highest accuracy — uses real datasheet values).
  // Falls back to Pmax-based lookup with Voc/Isc ratio derivation.
  const pmax = Number(fleetRow.stc_rating2)
  const modelName = fleetRow.pv_module_model ?? null
  const spec = findModuleSpec(
    Number.isFinite(pmax) && pmax > 0 ? pmax : null,
    voc,
    isc,
    modelName,
  )
  return {
    ...spec,
    name: fleetRow.pv_module_model ?? fleetRow.pv_module_make ?? spec.name,
  }
}

/**
 * Isc temperature coefficient for crystalline silicon (typical datasheet value).
 * Units: fraction per °C (+0.05 %/°C = +0.0005/°C)
 */
const ALPHA_ISC_PER_C = 0.0005
const T_STC = 25 // °C

/**
 * Compute estimated irradiance W/m² from measured DC current and module Isc.
 * When cell temperature is provided, corrects Isc to STC using the standard
 * linear temperature model:  Isc(T) = Isc_STC × (1 + α × (T - 25))
 * so that G = I_meas / Isc(T) × 1000 gives an irradiance independent of
 * the temperature-induced Isc lift (otherwise high temperatures falsely
 * suggest lower irradiance).
 */
function estimateIrradiance(
  measuredCurrent: number,
  isc: number,
  cellTempC?: number | null
): number | null {
  if (!Number.isFinite(isc) || isc <= 0 || !Number.isFinite(measuredCurrent)) return null
  const tempFactor = cellTempC != null && Number.isFinite(cellTempC)
    ? 1 + ALPHA_ISC_PER_C * (cellTempC - T_STC)
    : 1
  return (measuredCurrent / (isc * tempFactor)) * 1000
}


export default function ClippingAnalysisPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)

  const [selectedSites, setSelectedSites] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<ClippingType | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('duration_hours')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selectedEvent, setSelectedEvent] = useState<ClippingEvent | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [viCurveEvent, setViCurveEvent] = useState<ClippingEvent | null>(null)

  const [options, setOptions] = useState<ClippingOptions>(DEFAULT_CLIPPING_OPTIONS)

  // Pagination
  const PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 300, 400] as const
  const [pageSize, setPageSize] = useState<number>(20)
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    if (allSites.length > 0 && selectedSites.length === 0) {
      setSelectedSites([...allSites])
    }
  }, [allSites, selectedSites.length])

  // Load fleet data for France detection and module specs
  useEnsureFleetData()
  const { fleetRows } = useMultiSiteFleetInfo(selectedSites)

  const { hourlyRows, events, isLoading } = useClippingAnalysis(selectedSites, options, fleetRows)

  // Build a lookup: site_id → FleetSiteInfo[] for module specs & irradiance
  const fleetBySite = useMemo(() => {
    const map = new Map<string, FleetSiteInfo[]>()
    for (const r of fleetRows) {
      const list = map.get(r.site_id)
      if (list) list.push(r)
      else map.set(r.site_id, [r])
    }
    return map
  }, [fleetRows])

  // For a given event, find the best matching fleet row (by product_type / sku)
  const getFleetRowForEvent = useCallback((evt: ClippingEvent): FleetSiteInfo | undefined => {
    const siteRows = fleetBySite.get(evt.site_id)
    if (!siteRows || siteRows.length === 0) return undefined
    if (siteRows.length === 1) return siteRows[0]
    // Match by product_type prefix
    const sku = (evt.sku_name ?? '').toUpperCase()
    const match = siteRows.find((r) => sku.startsWith((r.product_type ?? '').toUpperCase()))
    return match ?? siteRows[0]
  }, [fleetBySite])

  const filteredEvents = useMemo(() => {
    if (typeFilter === 'all') return events
    return events.filter((e) => e.type === typeFilter)
  }, [events, typeFilter])

  const sortedEvents = useMemo(() => {
    const copy = [...filteredEvents]
    copy.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'site_id': cmp = a.site_id.localeCompare(b.site_id); break
        case 'serial_number': cmp = a.serial_number.localeCompare(b.serial_number); break
        case 'date': cmp = a.date.localeCompare(b.date); break
        case 'duration_hours': cmp = a.duration_hours - b.duration_hours; break
        case 'clipped_value': cmp = a.clipped_value - b.clipped_value; break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [filteredEvents, sortKey, sortDir])

  // Reset to page 1 whenever events, filters, or sort change
  useEffect(() => { setCurrentPage(1) }, [sortedEvents.length, typeFilter, sortKey, sortDir, pageSize])

  const totalPages = Math.max(1, Math.ceil(sortedEvents.length / pageSize))
  const paginatedEvents = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return sortedEvents.slice(start, start + pageSize)
  }, [sortedEvents, currentPage, pageSize])

  const handleSort = useCallback((key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'site_id' || key === 'serial_number' || key === 'date' ? 'asc' : 'desc')
    }
  }, [sortKey])

  // ── KPIs ─────────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const powerEvents = events.filter((e) => e.type === 'power')
    const currentEvents = events.filter((e) => e.type === 'current')
    const totalDuration = events.reduce((sum, e) => sum + e.duration_hours, 0)
    const invertersAffected = new Set(events.map((e) => e.serial_number)).size
    const sitesAffected = new Set(events.map((e) => e.site_id)).size
    return {
      powerCount: powerEvents.length,
      currentCount: currentEvents.length,
      totalDuration,
      invertersAffected,
      sitesAffected,
    }
  }, [events])

  // ── Detail chart for the selected event's inverter/day ──────────────
  const dayRows = useMemo(() => {
    if (!selectedEvent) return []
    return hourlyRows
      .filter((r) => r.serial_number === selectedEvent.serial_number && r.date === selectedEvent.date)
      .sort((a, b) => a.hour.localeCompare(b.hour))
  }, [hourlyRows, selectedEvent])

  const dayEvents = useMemo(() => {
    if (!selectedEvent) return []
    return events.filter(
      (e) => e.serial_number === selectedEvent.serial_number && e.date === selectedEvent.date
    )
  }, [events, selectedEvent])

  const detailChartOption = useMemo((): EChartsOption => {
    if (!selectedEvent || dayRows.length === 0) return {}
    const hours = dayRows.map((r) => fmtHourShort(r.hour))
    const powerData = dayRows.map((r) => safe(r.ac_power))
    const currentData = dayRows.map((r) => safe(r.dc_current))

    const buildMarkAreas = (type: ClippingType, color: string) =>
      dayEvents
        .filter((e) => e.type === type)
        .map((e) => {
          const startIdx = dayRows.findIndex((r) => r.hour === e.start_hour)
          const endIdx = dayRows.findIndex((r) => r.hour === e.end_hour)
          if (startIdx < 0 || endIdx < 0) return null
          return [
            { xAxis: hours[startIdx], itemStyle: { color } },
            { xAxis: hours[endIdx] },
          ]
        })
        .filter((v): v is NonNullable<typeof v> => v !== null)

    const powerMarkAreas = buildMarkAreas('power', 'rgba(239,68,68,0.16)')
    const currentMarkAreas = buildMarkAreas('current', 'rgba(59,130,246,0.16)')

    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 50, right: 60, bottom: 50, left: 60 },
      xAxis: { type: 'category', data: hours, axisLabel: { fontSize: 10 } },
      yAxis: [
        { type: 'value', name: 'AC Power (W)', position: 'left', nameTextStyle: { fontSize: 10 } },
        { type: 'value', name: 'DC Current (A)', position: 'right', nameTextStyle: { fontSize: 10 } },
      ],
      series: [
        {
          name: 'AC Power (W)',
          type: 'line',
          data: powerData,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: TYPE_COLORS.power, width: 2 },
          itemStyle: { color: TYPE_COLORS.power },
          ...(powerMarkAreas.length > 0 ? { markArea: { data: powerMarkAreas as never } } : {}),
        },
        {
          name: 'DC Current (A)',
          type: 'line',
          yAxisIndex: 1,
          data: currentData,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: TYPE_COLORS.current, width: 2 },
          itemStyle: { color: TYPE_COLORS.current },
          ...(currentMarkAreas.length > 0 ? { markArea: { data: currentMarkAreas as never } } : {}),
        },
      ],
    }
  }, [selectedEvent, dayRows, dayEvents])

  // ── VI Curve dialog data ────────────────────────────────────────────
  const viCurveSpec = useMemo((): ModuleSpec | null => {
    if (!viCurveEvent) return null
    const fleetRow = getFleetRowForEvent(viCurveEvent)
    return buildModuleSpec(fleetRow) ?? DEFAULT_MODULE_SPEC
  }, [viCurveEvent, getFleetRowForEvent])

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">
          No data loaded. <a href="#/upload" className="underline text-primary">Upload data</a> first.
        </p>
      </div>
    )
  }

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap"
      onClick={() => handleSort(field)}
    >
      {label}
      {sortKey === field && <span className="ml-1 text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>}
      {sortKey !== field && <ArrowUpDown className="ml-1 inline h-3 w-3 text-muted-foreground/50" />}
    </TableHead>
  )

  /** Get irradiance (W/m²) and irradiation (kWh/m²/month) from fleet data */
  const getFleetIrradianceInfo = (fRow: FleetSiteInfo | undefined) => {
    if (!fRow) return null
    const irrDay = Number(fRow.irr_ann_kwh_m2_month)
    if (!Number.isFinite(irrDay) || irrDay <= 0) return null
    // irr_ann_kwh_m2_month is kWh/m²/day (weighted daily avg of monthly GHI)
    const irrWm2 = irrDay * (1000 / 24) // Convert to W/m² (avg)
    const irrKwhMonth = irrDay * 30.44 // kWh/m²/month (avg month = 30.44 days)
    const irrKwhYear = irrDay * 365.25 // kWh/m²/year (annual total)
    return { irrWm2: Math.round(irrWm2 * 10) / 10, irrKwhMonth: Math.round(irrKwhMonth * 10) / 10, irrKwhYear: Math.round(irrKwhYear), irrDay }
  }

  /** Build companion columns text for current clipping row */
  const currentCompanions = (row: ClippingEvent) => {
    const fRow = getFleetRowForEvent(row)
    const isc = Number(fRow?.isc)
    const hasTemp = row.avg_temperature_c != null
    const estIrr = estimateIrradiance(row.clipped_value, isc, row.avg_temperature_c)
    const estIrrUncorrected = estimateIrradiance(row.clipped_value, isc)
    const fleetIrr = getFleetIrradianceInfo(fRow)
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>Avg V: <strong className="text-foreground">{fmt(row.avg_voltage)} V</strong></span>
        <span>Max V: <strong className="text-foreground">{fmt(row.max_voltage)} V</strong></span>
        <span>Avg P: <strong className="text-foreground">{fmt(row.avg_power)} W</strong></span>
        <span>Max P: <strong className="text-foreground">{fmt(row.max_power)} W</strong></span>
        {hasTemp && (
          <>
            <span>Avg Temp: <strong className="text-orange-500">{fmt(row.avg_temperature_c, 1)} °C</strong></span>
            <span>Max Temp: <strong className="text-red-500">{fmt(row.max_temperature_c, 1)} °C</strong></span>
          </>
        )}
        {estIrr !== null && (
          <span title={hasTemp ? `Temp-corrected (cell ${fmt(row.avg_temperature_c, 1)} °C, α=0.05%/°C)` : 'Uncorrected — no temperature data'}>
            Est. Irr{hasTemp ? ' ✱' : ''}: <strong className="text-amber-600">{Math.round(estIrr)} W/m²</strong>
          </span>
        )}
        {hasTemp && estIrrUncorrected !== null && estIrr !== null && Math.abs(estIrr - estIrrUncorrected) > 5 && (
          <span className="text-muted-foreground/60" title="Uncorrected estimate (no temperature adjustment)">
            (raw: {Math.round(estIrrUncorrected)} W/m²)
          </span>
        )}
        {fleetIrr && (
          <>
            <span>Irradiance: <strong className="text-sky-600">{fleetIrr.irrWm2} W/m²</strong></span>
            <span>Irradiation: <strong className="text-sky-600">{fleetIrr.irrKwhMonth} kWh/m²/mo</strong></span>
            <span>Annual: <strong className="text-amber-600">{fleetIrr.irrKwhYear} kWh/m²/yr</strong></span>
          </>
        )}
      </div>
    )
  }

  /** Build companion columns text for power clipping row */
  const powerCompanions = (row: ClippingEvent) => {
    const fRow = getFleetRowForEvent(row)
    const fleetIrr = getFleetIrradianceInfo(fRow)
    const hasTemp = row.avg_temperature_c != null
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>Avg V: <strong className="text-foreground">{fmt(row.avg_voltage)} V</strong></span>
        <span>Max V: <strong className="text-foreground">{fmt(row.max_voltage)} V</strong></span>
        <span>Avg I: <strong className="text-foreground">{fmt(row.avg_current)} A</strong></span>
        <span>Max I: <strong className="text-foreground">{fmt(row.max_current)} A</strong></span>
        {hasTemp && (
          <>
            <span>Avg Temp: <strong className="text-orange-500">{fmt(row.avg_temperature_c, 1)} °C</strong></span>
            <span>Max Temp: <strong className="text-red-500">{fmt(row.max_temperature_c, 1)} °C</strong></span>
          </>
        )}
        {fleetIrr && (
          <>
            <span>Irradiance: <strong className="text-sky-600">{fleetIrr.irrWm2} W/m²</strong></span>
            <span>Irradiation: <strong className="text-sky-600">{fleetIrr.irrKwhMonth} kWh/m²/mo</strong></span>
            <span>Annual: <strong className="text-amber-600">{fleetIrr.irrKwhYear} kWh/m²/yr</strong></span>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* VI Curve Dialog */}
      {viCurveEvent && (
        <VICurveDialog
          open={!!viCurveEvent}
          onOpenChange={(open) => { if (!open) setViCurveEvent(null) }}
          clippedCurrentA={viCurveEvent.clipped_value}
          avgVoltage={viCurveEvent.avg_voltage}
          moduleSpec={viCurveSpec}
          skuLabel={viCurveEvent.sku_name ?? viCurveEvent.serial_number}
          cellTempC={viCurveEvent.avg_temperature_c}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Scissors className="h-7 w-7 text-primary" />
            Clipping Analysis
          </h1>
          <p className="text-sm text-muted-foreground">
            Detects sustained flat-lining in hourly AC power (inverter power clipping) and DC current
            (current-limiting) curves — the two classic microinverter clipping signatures.
          </p>
        </div>
        <ExportToolbar
          elementId="clipping-content"
          filename="compdash-clipping-analysis"
          data={sortedEvents as unknown as Record<string, unknown>[]}
        />
      </div>

      <div id="clipping-content" className="space-y-6">
        {/* Filters */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <SiteSelector allSites={allSites} selectedSites={selectedSites} onChange={setSelectedSites} />
            <div className="flex flex-wrap items-center gap-4">
              <DateRangePicker />
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-sm font-medium">Type:</span>
                {(['all', 'power', 'current'] as const).map((t) => (
                  <Badge
                    key={t}
                    variant={typeFilter === t ? 'default' : 'secondary'}
                    className="cursor-pointer select-none capitalize"
                    onClick={() => setTypeFilter(t)}
                  >
                    {t}
                  </Badge>
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowAdvanced((v) => !v)} className="ml-auto">
                {showAdvanced ? 'Hide' : 'Tune'} Detection Sensitivity
              </Button>
            </div>

            {showAdvanced && (
              <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-5">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Power Buffer (W)</label>
                  <input
                    type="number" step={0.5} min={0}
                    value={options.powerBufferW}
                    onChange={(e) => setOptions((o) => ({ ...o, powerBufferW: Number(e.target.value) }))}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Current Buffer (A)</label>
                  <input
                    type="number" step={0.05} min={0}
                    value={options.currentBufferA}
                    onChange={(e) => setOptions((o) => ({ ...o, currentBufferA: Number(e.target.value) }))}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Min Power (W)</label>
                  <input
                    type="number" step={5} min={0}
                    value={options.minPowerW}
                    onChange={(e) => setOptions((o) => ({ ...o, minPowerW: Number(e.target.value) }))}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Min Current (A)</label>
                  <input
                    type="number" step={0.1} min={0}
                    value={options.minCurrentA}
                    onChange={(e) => setOptions((o) => ({ ...o, minCurrentA: Number(e.target.value) }))}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Min Consecutive Hours</label>
                  <input
                    type="number" step={1} min={1}
                    value={options.minConsecutiveHours}
                    onChange={(e) => setOptions((o) => ({ ...o, minConsecutiveHours: Number(e.target.value) }))}
                    className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Zap className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{kpi.powerCount}</p>
                <p className="text-sm text-muted-foreground">Power Clipping Events</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Gauge className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{kpi.currentCount}</p>
                <p className="text-sm text-muted-foreground">Current Clipping Events</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Clock className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{kpi.totalDuration.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Total Clipped Hours</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <Scissors className="h-8 w-8 text-purple-500" />
              <div>
                <p className="text-2xl font-bold">{kpi.invertersAffected}</p>
                <p className="text-sm text-muted-foreground">Inverters Affected</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <AlertTriangle className="h-8 w-8 text-orange-500" />
              <div>
                <p className="text-2xl font-bold">{kpi.sitesAffected}</p>
                <p className="text-sm text-muted-foreground">Sites Affected</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Scanning hourly curves for clipping…
          </div>
        ) : (
          <>
            {/* Detail chart for selected event */}
            {selectedEvent && (
              <Card>
                <CardHeader className="flex flex-row items-start justify-between">
                  <div>
                    <CardTitle className="text-base">
                      {selectedEvent.serial_number} — {selectedEvent.date}
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        (Site {selectedEvent.site_id})
                      </span>
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Shaded regions mark detected clipping windows —{' '}
                      <span className="text-red-500">red = power</span>,{' '}
                      <span className="text-blue-500">blue = current</span>
                    </p>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => setSelectedEvent(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SiteContextPanel siteId={selectedEvent.site_id} />
                  <LineChart option={detailChartOption} height={360} />
                </CardContent>
              </Card>
            )}

            {/* Events table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Clipping Instances
                  {sortedEvents.length > 0 && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      ({sortedEvents.length} events)
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {sortedEvents.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No clipping detected with the current filters/sensitivity.
                  </p>
                ) : (
                  <>
                    <div className="scrollbar-visible overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <SortHeader label="Site" field="site_id" />
                            <SortHeader label="Serial Number" field="serial_number" />
                            <TableHead className="whitespace-nowrap">SKU</TableHead>
                            <TableHead className="whitespace-nowrap">Type</TableHead>
                            <SortHeader label="Date" field="date" />
                            <TableHead className="whitespace-nowrap">Start</TableHead>
                            <TableHead className="whitespace-nowrap">End</TableHead>
                            <SortHeader label="Duration (h)" field="duration_hours" />
                            <SortHeader label="Clipped Value" field="clipped_value" />
                            <TableHead className="whitespace-nowrap">% of Rated</TableHead>
                            <TableHead className="whitespace-nowrap">Companion Metrics</TableHead>
                            <TableHead className="whitespace-nowrap">VI Curve</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedEvents.map((row, idx) => (
                            <TableRow
                              key={`${row.serial_number}-${row.date}-${row.type}-${row.start_hour}-${idx}`}
                              className={`cursor-pointer hover:bg-muted/50 ${
                                selectedEvent === row ? 'bg-primary/10' : ''
                              }`}
                              onClick={() => setSelectedEvent(row)}
                            >
                              <TableCell className="text-xs">
                                <a
                                  href={`https://enlighten.enphaseenergy.com/admin/sites/${row.site_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {row.site_id}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </TableCell>
                              <TableCell className="font-mono text-xs">{row.serial_number}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{row.sku_name ?? '—'}</TableCell>
                              <TableCell>
                                <Badge
                                  variant={row.type === 'power' ? 'destructive' : 'secondary'}
                                  className="capitalize"
                                >
                                  {row.type}
                                </Badge>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-xs">{row.date}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs">{fmtHour(row.start_hour)}</TableCell>
                              <TableCell className="whitespace-nowrap text-xs">{fmtHour(row.end_hour)}</TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {row.duration_hours}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {fmt(row.clipped_value)} {row.type === 'power' ? 'W' : 'A'}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {row.pct_of_rated != null ? `${fmt(row.pct_of_rated, 0)}%` : '—'}
                              </TableCell>
                              <TableCell className="min-w-[200px]">
                                {row.type === 'current' ? currentCompanions(row) : powerCompanions(row)}
                              </TableCell>
                              <TableCell>
                                {row.type === 'current' && (
                                  <Button
                                    variant="outline"
                                    size="xs"
                                    className="h-6 gap-1 px-1.5 text-[10px]"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setViCurveEvent(row)
                                    }}
                                  >
                                    <TrendingUp className="h-3 w-3" />
                                    VI Curve
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Pagination controls */}
                    <div className="flex items-center justify-between border-t pt-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span>Rows per page:</span>
                        <select
                          value={pageSize}
                          onChange={(e) => setPageSize(Number(e.target.value))}
                          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                        >
                          {PAGE_SIZE_OPTIONS.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">
                          {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, sortedEvents.length)} of {sortedEvents.length}
                        </span>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          disabled={currentPage <= 1}
                          onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span className="min-w-[3rem] text-center font-medium">
                          {currentPage} / {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          disabled={currentPage >= totalPages}
                          onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
