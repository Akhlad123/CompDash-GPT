import { useMemo, useState, useCallback } from 'react'
import { AlertTriangle, Loader2, ShieldCheck, ShieldAlert, ExternalLink } from 'lucide-react'
import type { EChartsOption } from 'echarts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import SiteSelector from '@/components/filters/SiteSelector'
import BarChart from '@/components/charts/BarChart'
import ExportToolbar from '@/components/export/ExportToolbar'
import { useDataStore } from '@/store/dataStore'
import { useAnomalyData } from '@/hooks/useAnomalyData'
import type { AnomalyStatus } from '@/hooks/useAnomalyData'

const STATUS_COLORS: Record<AnomalyStatus, string> = {
  normal: '#22c55e',
  warning: '#f59e0b',
  alert: '#ef4444',
}

const STATUS_VARIANTS: Record<AnomalyStatus, 'default' | 'secondary' | 'destructive'> = {
  normal: 'default',
  warning: 'secondary',
  alert: 'destructive',
}

type SortKey = 'serial_number' | 'site_id' | 'total_energy' | 'z_score' | 'status'

function safe(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmt(v: unknown, decimals = 2): string {
  const n = safe(v)
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export default function AnomalyPage() {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const allSites = useDataStore((s) => s.sites)

  const [selectedSites, setSelectedSites] = useState<string[]>([])
  const [warnThreshold, setWarnThreshold] = useState(1.5)
  const [alertThreshold, setAlertThreshold] = useState(2.0)
  const [sortKey, setSortKey] = useState<SortKey>('z_score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [statusFilter, setStatusFilter] = useState<AnomalyStatus | 'all'>('all')

  // Initialize selected sites when data loads
  useMemo(() => {
    if (allSites.length > 0 && selectedSites.length === 0) {
      setSelectedSites([...allSites])
    }
  }, [allSites])

  const { data, isLoading, alertCount, warningCount, normalCount } = useAnomalyData(
    selectedSites,
    warnThreshold,
    alertThreshold
  )

  const handleSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      else {
        setSortKey(key)
        setSortDir(key === 'serial_number' || key === 'site_id' ? 'asc' : 'desc')
      }
    },
    [sortKey]
  )

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return data
    return data.filter((r) => r.status === statusFilter)
  }, [data, statusFilter])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'serial_number':
          cmp = a.serial_number.localeCompare(b.serial_number)
          break
        case 'site_id':
          cmp = a.site_id.localeCompare(b.site_id)
          break
        case 'total_energy':
          cmp = safe(a.total_energy) - safe(b.total_energy)
          break
        case 'z_score':
          cmp = a.abs_z - b.abs_z
          break
        case 'status': {
          const order: Record<AnomalyStatus, number> = { alert: 3, warning: 2, normal: 1 }
          cmp = order[a.status] - order[b.status]
          break
        }
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [filtered, sortKey, sortDir])

  // ── Bar chart option ────────────────────────────────────────────
  const barOption = useMemo((): EChartsOption => {
    if (sorted.length === 0) return {}

    const labels = sorted.map((r) => r.serial_number)
    const values = sorted.map((r) => ({
      value: safe(r.total_energy) / 1000,
      itemStyle: { color: STATUS_COLORS[r.status] },
    }))

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as Record<string, unknown>
          const idx = safe(p?.dataIndex)
          const row = sorted[idx]
          if (!row) return ''
          return `<b>${row.serial_number}</b><br/>
            Site: ${row.site_id}<br/>
            Energy: ${fmt(safe(row.total_energy) / 1000)} kWh<br/>
            Z-score: ${fmt(row.z_score, 3)}<br/>
            Status: ${row.status}<br/>
            <span style="color:#888;font-size:11px">${row.reason}</span>`
        },
      },
      grid: { top: 10, right: 20, bottom: 60, left: 55 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { rotate: 45, fontSize: 9 },
      },
      yAxis: {
        type: 'value',
        name: 'Total Energy (kWh)',
        nameTextStyle: { fontSize: 10 },
      },
      series: [
        {
          type: 'bar',
          data: values,
          barMaxWidth: 30,
        },
      ],
    }
  }, [sorted])

  if (!isDataLoaded) {
    return (
      <div className="p-6">
        <p className="text-lg text-muted-foreground">
          No data loaded.{' '}
          <a href="#/upload" className="underline text-primary">Upload data</a> first.
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
      {sortKey === field && (
        <span className="ml-1 text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </TableHead>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Anomaly Detection</h1>
        <ExportToolbar
          elementId="anomaly-content"
          filename="compdash-anomaly"
          data={sorted as unknown as Record<string, unknown>[]}
        />
      </div>

      <div id="anomaly-content" className="space-y-4">
        {/* Filters */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <SiteSelector
              allSites={allSites}
              selectedSites={selectedSites}
              onChange={setSelectedSites}
            />
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Warning ≥</label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={alertThreshold}
                  value={warnThreshold}
                  onChange={(e) => setWarnThreshold(Number(e.target.value))}
                  className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">σ</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Alert ≥</label>
                <input
                  type="number"
                  step={0.1}
                  min={warnThreshold}
                  value={alertThreshold}
                  onChange={(e) => setAlertThreshold(Number(e.target.value))}
                  className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">σ</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium mr-1">Filter:</span>
                {(['all', 'alert', 'warning', 'normal'] as const).map((s) => (
                  <Badge
                    key={s}
                    variant={statusFilter === s ? 'default' : 'secondary'}
                    className="cursor-pointer select-none capitalize"
                    onClick={() => setStatusFilter(s)}
                  >
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <ShieldAlert className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{alertCount}</p>
                <p className="text-sm text-muted-foreground">Alert Inverters</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{warningCount}</p>
                <p className="text-sm text-muted-foreground">Warning Inverters</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <ShieldCheck className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{normalCount}</p>
                <p className="text-sm text-muted-foreground">Normal Inverters</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Analyzing anomalies…
          </div>
        ) : (
          <>
            {/* Bar Chart */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Total Energy by Inverter (colored by anomaly status)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <BarChart
                  option={barOption}
                  height={Math.max(320, sorted.length * 12)}
                />
              </CardContent>
            </Card>

            {/* Table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Inverter Anomaly Details
                  {sorted.length > 0 && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      ({sorted.length} inverters)
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sorted.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No anomalies found with current filters.
                  </p>
                ) : (
                  <div className="max-h-[500px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <SortHeader label="Serial Number" field="serial_number" />
                          <SortHeader label="Site" field="site_id" />
                          <TableHead className="whitespace-nowrap">SKU</TableHead>
                          <SortHeader label="Total Energy (kWh)" field="total_energy" />
                          <TableHead className="whitespace-nowrap">Site Mean</TableHead>
                          <TableHead className="whitespace-nowrap">Site Std</TableHead>
                          <SortHeader label="Z-Score" field="z_score" />
                          <SortHeader label="Status" field="status" />
                          <TableHead className="min-w-[260px]">Reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sorted.map((row) => (
                          <TableRow key={`${row.serial_number}-${row.site_id}`}>
                            <TableCell className="font-mono text-xs">
                              {row.serial_number}
                            </TableCell>
                            <TableCell className="text-xs">
                              <a
                                href={`https://enlighten.enphaseenergy.com/admin/sites/${row.site_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                              >
                                {row.site_id}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.sku_name ?? '—'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmt(safe(row.total_energy) / 1000)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {fmt(safe(row.site_mean) / 1000)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {fmt(safe(row.site_std) / 1000)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium">
                              {fmt(row.z_score, 3)}
                            </TableCell>
                            <TableCell>
                              <Badge variant={STATUS_VARIANTS[row.status]}>
                                {row.status === 'normal'
                                  ? 'Normal'
                                  : row.status === 'warning'
                                    ? 'Warning'
                                    : 'Alert'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[360px]">
                              {row.reason}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
