import { useMemo, useState, useCallback, Fragment, Component, type ReactNode, type ErrorInfo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MapPin,
  Cpu,
  Zap,
  CalendarDays,
  ArrowUpDown,
  ArrowRight,
  AlertTriangle,
  Loader2,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Sun,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
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
import KPICard from '@/components/layout/KPICard'
import DateRangePicker from '@/components/filters/DateRangePicker'
import GranularityToggle from '@/components/filters/GranularityToggle'
import ExportToolbar from '@/components/export/ExportToolbar'
import SiteContextPanel from '@/components/fleet/SiteContextPanel'
import { useDataStore } from '@/store/dataStore'
import { useKPITotals } from '@/hooks/useKPITotals'
import { useSiteStats } from '@/hooks/useSiteStats'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useMultiSiteFleetInfo } from '@/hooks/useMultiSiteFleetInfo'
import { useDailySiteEnergy } from '@/hooks/useDailySiteEnergy'
import { query as duckQuery } from '@/lib/duckdb'
import { buildDateFilter } from '@/lib/queries'
import type { SiteSummaryRow } from '@/hooks/useSiteStats'

type SortKey = keyof Pick<
  SiteSummaryRow,
  | 'site_id'
  | 'inverter_count'
  | 'total_energy'
  | 'avg_dc_power'
  | 'avg_temperature'
>

interface InverterEnergyRow {
  serial_number: string
  site_id: string
  sku_name: string | null
  total_energy: number
}

function safe(n: unknown): number {
  if (n === null || n === undefined) return 0
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function formatEnergy(wh: unknown): string {
  const kwh = safe(wh) / 1000
  if (kwh >= 1_000_000) return `${(kwh / 1_000_000).toFixed(1)} GWh`
  if (kwh >= 1_000) return `${(kwh / 1_000).toFixed(1)} MWh`
  return `${kwh.toFixed(1)} kWh`
}

function formatNum(n: unknown, decimals = 1): string {
  return safe(n).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatDate(d: unknown): string {
  if (!d) return ''
  try {
    const date = new Date(String(d))
    if (Number.isNaN(date.getTime())) return String(d)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return String(d)
  }
}

class OverviewErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[OverviewPage Error]', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="space-y-4 p-6">
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
            <p className="font-semibold">Render Error</p>
            <pre className="mt-2 whitespace-pre-wrap text-sm">{this.state.error.message}</pre>
            <pre className="mt-2 whitespace-pre-wrap text-xs opacity-60">{this.state.error.stack}</pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function OverviewPage() {
  return (
    <OverviewErrorBoundary>
      <OverviewContent />
    </OverviewErrorBoundary>
  )
}

function OverviewContent() {
  const navigate = useNavigate()
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  const { data: kpi, isLoading: kpiLoading, error: kpiError } = useKPITotals()
  const { data: sites, isLoading: sitesLoading, error: sitesError } = useSiteStats()
  const { data: dailyEnergy } = useDailySiteEnergy()

  // Fleet data for irradiance/irradiation
  useEnsureFleetData()
  const allSiteIds = useMemo(() => sites?.map((s) => s.site_id) ?? [], [sites])
  const { fleetRows } = useMultiSiteFleetInfo(allSiteIds)
  const fleetBySite = useMemo(() => {
    const map = new Map<string, { irrWm2: number; irrKwhMonth: number }>()
    for (const row of fleetRows) {
      if (map.has(row.site_id)) continue // take first row per site
      const irrDay = Number(row.irr_ann_kwh_m2_month)
      if (!Number.isFinite(irrDay) || irrDay <= 0) continue
      map.set(row.site_id, {
        irrWm2: Math.round(irrDay * (1000 / 24) * 10) / 10,
        irrKwhMonth: Math.round(irrDay * 30.44 * 10) / 10,
      })
    }
    return map
  }, [fleetRows])

  const { data: inverterEnergy } = useQuery<InverterEnergyRow[]>({
    queryKey: ['inverterEnergy', dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: () => {
      const df = buildDateFilter(dateRange)
      const sql = `SELECT serial_number, site_id, sku_name, SUM(energy_produced) AS total_energy FROM telemetry WHERE 1=1 ${df} GROUP BY serial_number, site_id, sku_name ORDER BY site_id, serial_number`
      return duckQuery<InverterEnergyRow>(sql)
    },
    enabled: isDataLoaded,
  })

  const invertersBySite = useMemo(() => {
    const map = new Map<string, InverterEnergyRow[]>()
    if (!inverterEnergy) return map
    for (const row of inverterEnergy) {
      const list = map.get(row.site_id) ?? []
      list.push(row)
      map.set(row.site_id, list)
    }
    return map
  }, [inverterEnergy])

  const queryError = kpiError || sitesError

  const [sortKey, setSortKey] = useState<SortKey>('site_id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [expandedSites, setExpandedSites] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((siteId: string) => {
    setExpandedSites((prev) => {
      const next = new Set(prev)
      if (next.has(siteId)) next.delete(siteId)
      else next.add(siteId)
      return next
    })
  }, [])

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortKey(key)
        setSortDir('asc')
      }
    },
    [sortKey]
  )

  const sortedSites = useMemo(() => {
    if (!sites) return []
    const sorted = [...sites]
    sorted.sort((a, b) => {
      const aVal = a[sortKey]
      const bVal = b[sortKey]
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal)
      }
      const diff = safe(aVal) - safe(bVal)
      return sortDir === 'asc' ? diff : -diff
    })
    return sorted
  }, [sites, sortKey, sortDir])

  const sparklineMap = useMemo(() => {
    if (!dailyEnergy) return new Map<string, number[]>()
    const grouped = new Map<string, { date: string; energy: number }[]>()
    for (const row of dailyEnergy) {
      const list = grouped.get(row.site_id) ?? []
      list.push({ date: String(row.date ?? ''), energy: safe(row.daily_energy) })
      grouped.set(row.site_id, list)
    }
    const result = new Map<string, number[]>()
    for (const [siteId, rows] of grouped) {
      const sorted = rows.sort((a, b) => a.date.localeCompare(b.date))
      const last7 = sorted.slice(-7)
      result.set(siteId, last7.map((r) => r.energy / 1000))
    }
    return result
  }, [dailyEnergy])

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">No data loaded. <a href="#/upload" className="underline text-primary">Upload data</a> first.</p>
      </div>
    )
  }

  if (queryError) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">
          <p className="font-semibold">Query Error</p>
          <pre className="mt-2 whitespace-pre-wrap text-sm">
            {queryError instanceof Error ? queryError.message : JSON.stringify(queryError)}
          </pre>
        </div>
      </div>
    )
  }

  const loading = kpiLoading || sitesLoading

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <ExportToolbar
          elementId="overview-content"
          filename="compdash-overview"
          data={(sortedSites as unknown as Record<string, unknown>[])}
        />
      </div>

      <div id="overview-content" className="space-y-6">
      {/* KPI Cards */}
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading KPIs…
        </div>
      ) : kpi ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            icon={MapPin}
            label="Total Sites"
            value={String(safe(kpi.total_sites))}
          />
          <KPICard
            icon={Cpu}
            label="Total Microinverters"
            value={String(safe(kpi.total_inverters))}
          />
          <KPICard
            icon={Zap}
            label="Total Energy Produced"
            value={formatEnergy(kpi.total_energy)}
          />
          <KPICard
            icon={CalendarDays}
            label="Date Range"
            value={
              kpi.date_from && kpi.date_to
                ? `${formatDate(kpi.date_from)} — ${formatDate(kpi.date_to)}`
                : 'N/A'
            }
          />
        </div>
      ) : null}

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-4 pb-4">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Date Range:</span>
          </div>
          <DateRangePicker />
          {dateRange && (
            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
              {formatDate(dateRange.from)} — {formatDate(dateRange.to)}
            </span>
          )}
          <div className="ml-auto">
            <GranularityToggle />
          </div>
        </CardContent>
      </Card>

      {/* Site Summary Table */}
      <Card>
        <CardHeader>
          <CardTitle>Site Summary</CardTitle>
        </CardHeader>
        <CardContent>
          {sitesLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sites…
            </div>
          ) : sortedSites.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              No site data available.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('site_id')}>
                      <span className="flex items-center gap-1">Site ID <ArrowUpDown className="h-3 w-3 text-muted-foreground" /></span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('inverter_count')}>
                      <span className="flex items-center gap-1"># Inverters <ArrowUpDown className="h-3 w-3 text-muted-foreground" /></span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('total_energy')}>
                      <span className="flex items-center gap-1">Total Energy (kWh) <ArrowUpDown className="h-3 w-3 text-muted-foreground" /></span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('avg_dc_power')}>
                      <span className="flex items-center gap-1">Avg DC Power (W) <ArrowUpDown className="h-3 w-3 text-muted-foreground" /></span>
                    </TableHead>
                    <TableHead className="cursor-pointer select-none" onClick={() => handleSort('avg_temperature')}>
                      <span className="flex items-center gap-1">Avg Temp (°C) <ArrowUpDown className="h-3 w-3 text-muted-foreground" /></span>
                    </TableHead>
                    <TableHead>
                      <span className="flex items-center gap-1"><Sun className="h-3 w-3 text-amber-500" /> Irradiance</span>
                    </TableHead>
                    <TableHead>7-Day Trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedSites.map((site) => {
                    const isExpanded = expandedSites.has(site.site_id)
                    const siteInverters = invertersBySite.get(site.site_id) ?? []
                    return (
                      <Fragment key={site.site_id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                        >
                          <TableCell
                            className="w-8 px-2"
                            onClick={(e) => { e.stopPropagation(); toggleExpand(site.site_id) }}
                          >
                            {isExpanded
                              ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          </TableCell>
                          <TableCell className="font-medium">
                            <a
                              href={`https://enlighten.enphaseenergy.com/admin/sites/${site.site_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {site.site_id}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </TableCell>
                          <TableCell>{safe(site.inverter_count)}</TableCell>
                          <TableCell>{formatNum(safe(site.total_energy) / 1000)}</TableCell>
                          <TableCell>{formatNum(site.avg_dc_power)}</TableCell>
                          <TableCell>{formatNum(site.avg_temperature)}</TableCell>
                          <TableCell>
                            {(() => {
                              const fi = fleetBySite.get(site.site_id)
                              if (!fi) return <span className="text-xs text-muted-foreground">—</span>
                              return (
                                <div className="text-xs">
                                  <span className="font-medium">{fi.irrWm2} W/m²</span>
                                  <br />
                                  <span className="text-muted-foreground">{fi.irrKwhMonth} kWh/m²/mo</span>
                                </div>
                              )
                            })()}
                          </TableCell>
                          <TableCell>
                            {(() => {
                              const vals = sparklineMap.get(site.site_id) ?? []
                              if (vals.length === 0) return <span className="text-xs text-muted-foreground">—</span>
                              const max = Math.max(...vals)
                              return (
                                <div className="flex h-8 items-end gap-px">
                                  {vals.map((v, i) => (
                                    <div
                                      key={i}
                                      className="w-2 rounded-t bg-primary/60"
                                      style={{ height: `${max > 0 ? (v / max) * 100 : 0}%`, minHeight: 2 }}
                                    />
                                  ))}
                                </div>
                              )
                            })()}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="bg-muted/30">
                            <TableCell></TableCell>
                            <TableCell colSpan={7} className="pb-3 pl-8 pt-2">
                              <SiteContextPanel siteId={site.site_id} />
                            </TableCell>
                          </TableRow>
                        )}
                        {isExpanded && siteInverters.map((inv) => (
                          <TableRow key={`${site.site_id}-${inv.serial_number}`} className="bg-muted/30">
                            <TableCell></TableCell>
                            <TableCell className="pl-8 text-xs font-mono text-muted-foreground">{inv.serial_number}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{inv.sku_name ?? '—'}</TableCell>
                            <TableCell className="text-xs">{formatNum(safe(inv.total_energy) / 1000)}</TableCell>
                            <TableCell colSpan={4}></TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      </div>

      {/* Quick actions */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate('/sites')}>
          Compare Sites
          <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
        <Button variant="outline" onClick={() => navigate('/anomaly')}>
          Detect Anomalies
          <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
