import { useState, useMemo, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2, AlertTriangle, ShieldAlert, Download, ChevronDown, ChevronUp,
  Zap, ThermometerSun, PlugZap, ExternalLink, RotateCcw, ArrowLeftRight,
  TrendingDown, BarChart3, Lightbulb,
} from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import KPICard from '@/components/layout/KPICard'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter,
  FLEET_DISTINCT_TSS_REGIONS,
  FLEET_DISTINCT_QUARTERS,
  FLEET_DISTINCT_PRODUCT_TYPES,
  COMPLIANCE_CIRCUIT_PHASE,
  COMPLIANCE_THREE_PHASE,
  COMPLIANCE_MODULE_LIMITS,
  COMPLIANCE_SUMMARY,
  RMA_COMPLIANCE_CORRELATION,
  RMA_COMPLIANCE_DETAIL,
  COMPLIANCE_RMA_TREND,
} from '@/lib/fleetQueries'
import { useEnsureRmaData } from '@/hooks/useRmaData'
import { tssRegionLabel } from '@/lib/fleetRegions'

const ENLIGHTEN_BASE = 'https://enlighten.enphaseenergy.com/admin/sites/'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CircuitPhaseRow {
  site_id: string
  country: string
  tss_region: string
  tss_country: string
  state: string
  city: string
  product_type: string
  model_name: string
  circuit_phase: string
  pv_module_make: string
  pv_module_model: string
  unit_count: number
}

interface ThreePhaseRow {
  site_id: string
  country: string
  tss_region: string
  tss_country: string
  state: string
  city: string
  product_type: string
  model_name: string
  production_eim_config: string
  consumption_eim_config: string
  pv_module_make: string
  pv_module_model: string
  unit_count: number
}

interface ModuleLimitRow {
  site_id: string
  country: string
  tss_region: string
  tss_country: string
  state: string
  city: string
  product_type: string
  model_name: string
  pv_module_make: string
  pv_module_model: string
  voc: number
  isc: number
  voc_at_temp: number
  isc_at_temp: number
  max_voc: number
  max_isc: number
  voc_exceeded: number
  isc_exceeded: number
  unit_count: number
}

interface SummaryRow {
  cat1_sites: number
  cat1_units: number
  cat2_sites: number
  cat2_units: number
}

type ComplianceTab = 'circuit_phase' | 'three_phase' | 'module_limits'

type RmaCorrelationMode = 'all' | 'cat1' | 'cat2' | 'cat3'

interface RmaCorrelationSummary {
  violation_sites: number
  sites_with_rma: number
  total_rmas: number
  units_affected: number
  dppm: number
}

interface RmaDetailRow {
  site_id: string
  state: string
  country: string
  product_type: string
  returned_sku: string | null
  replacement_sku: string | null
  fleet_units: number
  rma_count: number
  pv_module_model: string | null
  voc: number | null
  voc_at_temp: number | null
  isc: number | null
  isc_at_temp: number | null
  cat1_fail: number
  cat2_fail: number
  cat3_fail: number
}

type TrendCategory = 'all' | 'cat1' | 'cat2' | 'cat3'

interface TrendRow {
  half_year: string
  compliant_installations: number
  nc_installations: number
  compliant_sites: number
  nc_site_count: number
  compliant_rma: number
  nc_rma: number
}

interface TrendRowWithCumulative extends TrendRow {
  cum_compliant_inst: number
  cum_nc_inst: number
  compliant_dppm: number
  nc_dppm: number
  compliant_rma_rate: number
  nc_rma_rate: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown): string {
  return safe(n).toLocaleString()
}

function downloadCsv<T extends Record<string, unknown>>(filename: string, headers: string[], rows: T[]) {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function FleetCompliancePage() {
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()

  // Local filters (not global fleetStore, avoids cross-page interference)
  const [selQuarters, setSelQuarters] = useState<string[]>([])
  const [selRegions, setSelRegions] = useState<string[]>([])
  const [selProducts, setSelProducts] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<ComplianceTab>('circuit_phase')
  const [expanded, setExpanded] = useState(true)
  const [lowTemp, setLowTemp] = useState('-40')
  const [highTemp, setHighTemp] = useState('60')
  const [appliedLowTemp, setAppliedLowTemp] = useState(-40)
  const [appliedHighTemp, setAppliedHighTemp] = useState(60)
  const [violationFilter, setViolationFilter] = useState<'all' | 'voc_only' | 'isc_only' | 'both'>('all')

  const isDefaultTemp = appliedLowTemp === -40 && appliedHighTemp === 60
  const tempDirty = parseInt(lowTemp, 10) !== appliedLowTemp || parseInt(highTemp, 10) !== appliedHighTemp

  const handleApplyTemp = () => {
    const lo = parseInt(lowTemp, 10)
    const hi = parseInt(highTemp, 10)
    if (!isNaN(lo) && !isNaN(hi)) {
      setAppliedLowTemp(lo)
      setAppliedHighTemp(hi)
    }
  }
  const handleResetTemp = () => {
    setLowTemp('-40')
    setHighTemp('60')
    setAppliedLowTemp(-40)
    setAppliedHighTemp(60)
  }

  const where = useMemo(() => {
    const parts = [buildFleetFilter({ quarters: selQuarters, tssRegions: selRegions })]
    if (selProducts.length > 0) {
      parts.push(`product_type IN (${selProducts.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')})`)
    }
    return parts.join(' AND ')
  }, [selQuarters, selRegions, selProducts])

  // Filter options
  const { data: quarters } = useQuery({
    queryKey: ['compliance-quarters'],
    queryFn: () => query<{ quarter: string }>(FLEET_DISTINCT_QUARTERS),
    enabled: !fleetLoading,
  })
  const { data: regions } = useQuery({
    queryKey: ['compliance-regions'],
    queryFn: () => query<{ tss_region: string }>(FLEET_DISTINCT_TSS_REGIONS),
    enabled: !fleetLoading,
  })
  const { data: products } = useQuery({
    queryKey: ['compliance-products'],
    queryFn: () => query<{ product_type: string }>(FLEET_DISTINCT_PRODUCT_TYPES),
    enabled: !fleetLoading,
  })

  // Summary KPIs
  const { data: summary } = useQuery({
    queryKey: ['compliance-summary', where],
    queryFn: () => query<SummaryRow>(COMPLIANCE_SUMMARY(where)),
    enabled: !fleetLoading,
  })

  // Category 1
  const { data: cat1Rows, isLoading: cat1Loading } = useQuery({
    queryKey: ['compliance-cat1', where],
    queryFn: () => query<CircuitPhaseRow>(COMPLIANCE_CIRCUIT_PHASE(where)),
    enabled: !fleetLoading && activeTab === 'circuit_phase',
  })

  // Category 2
  const { data: cat2Rows, isLoading: cat2Loading } = useQuery({
    queryKey: ['compliance-cat2', where],
    queryFn: () => query<ThreePhaseRow>(COMPLIANCE_THREE_PHASE(where)),
    enabled: !fleetLoading && activeTab === 'three_phase',
  })

  // Category 3 — uses appliedLowTemp for Voc, appliedHighTemp for Isc
  const { data: cat3Rows, isLoading: cat3Loading } = useQuery({
    queryKey: ['compliance-cat3', where, appliedLowTemp, appliedHighTemp],
    queryFn: () => query<ModuleLimitRow>(COMPLIANCE_MODULE_LIMITS(where, appliedLowTemp, appliedHighTemp)),
    enabled: !fleetLoading && activeTab === 'module_limits',
  })

  const s = summary?.[0]

  const cat3VocOnly = cat3Rows?.filter((r) => r.voc_exceeded === 1 && r.isc_exceeded === 0) ?? []
  const cat3IscOnly = cat3Rows?.filter((r) => r.isc_exceeded === 1 && r.voc_exceeded === 0) ?? []
  const cat3BothArr = cat3Rows?.filter((r) => r.voc_exceeded === 1 && r.isc_exceeded === 1) ?? []
  const cat3Count = cat3Rows?.length ?? 0
  const cat3Units = cat3Rows?.reduce((acc, r) => acc + safe(r.unit_count), 0) ?? 0
  const cat3Sites = cat3Rows ? new Set(cat3Rows.map((r) => r.site_id)).size : 0

  const filteredCat3 = useMemo(() => {
    if (!cat3Rows) return undefined
    switch (violationFilter) {
      case 'voc_only': return cat3VocOnly
      case 'isc_only': return cat3IscOnly
      case 'both':     return cat3BothArr
      default:         return cat3Rows
    }
  }, [cat3Rows, cat3VocOnly, cat3IscOnly, cat3BothArr, violationFilter])

  // ─── RMA correlation ─────────────────────────────────────────────────────

  const { isRmaLoaded, isRmaLoading } = useEnsureRmaData()
  const [rmaMode, setRmaMode] = useState<RmaCorrelationMode>('all')
  const [rmaExpanded, setRmaExpanded] = useState(true)

  // RMA KPI summary
  const { data: rmaCorr, isLoading: rmaCorrLoading } = useQuery({
    queryKey: ['rma-correlation', where, rmaMode, appliedLowTemp, appliedHighTemp],
    queryFn: () => query<RmaCorrelationSummary>(
      RMA_COMPLIANCE_CORRELATION(where, rmaMode, appliedLowTemp, appliedHighTemp)
    ),
    enabled: !fleetLoading && isRmaLoaded,
  })

  // RMA detail table
  const { data: rmaDetail, isLoading: rmaDetailLoading } = useQuery({
    queryKey: ['rma-detail', where, rmaMode, appliedLowTemp, appliedHighTemp],
    queryFn: () => query<RmaDetailRow>(
      RMA_COMPLIANCE_DETAIL(where, rmaMode, appliedLowTemp, appliedHighTemp)
    ),
    enabled: !fleetLoading && isRmaLoaded && rmaExpanded,
  })

  const rc = rmaCorr?.[0]
  const rmaDetailWithRma = useMemo(
    () => (rmaDetail ?? []).filter((r) => safe(r.rma_count) > 0),
    [rmaDetail],
  )

  const exportRmaDetail = useCallback(() => {
    if (!rmaDetailWithRma.length) return
    downloadCsv('rma_compliance_correlation.csv',
      ['site_id', 'state', 'country', 'product_type', 'returned_sku', 'replacement_sku', 'fleet_units', 'rma_count', 'pv_module_model', 'voc', 'voc_at_temp', 'isc', 'isc_at_temp', 'cat1_fail', 'cat2_fail', 'cat3_fail'],
      rmaDetailWithRma as unknown as Record<string, unknown>[])
  }, [rmaDetailWithRma])

  // ─── Section 3: Installation vs RMA Trend ────────────────────────────────

  const [trendCategory, setTrendCategory] = useState<TrendCategory>('all')

  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ['compliance-rma-trend', where, trendCategory, appliedLowTemp, appliedHighTemp],
    queryFn: () => query<TrendRow>(
      COMPLIANCE_RMA_TREND(where, trendCategory, appliedLowTemp, appliedHighTemp)
    ),
    enabled: !fleetLoading && isRmaLoaded,
  })

  // Canonical half-year sort order
  const HALF_YEAR_ORDER = ['H2-23', 'H1-24', 'H2-24', 'H1-25', 'H2-25', 'H1-26', 'H2-26']

  // Sort chronologically and compute cumulative installations + DPPM per period
  const sortedTrend: TrendRowWithCumulative[] = useMemo(() => {
    if (!trendData) return []
    const sorted = [...trendData]
      .filter((r) => HALF_YEAR_ORDER.includes(r.half_year))
      .sort((a, b) => HALF_YEAR_ORDER.indexOf(a.half_year) - HALF_YEAR_ORDER.indexOf(b.half_year))

    let cumC = 0
    let cumNC = 0
    return sorted.map((r) => {
      cumC += safe(r.compliant_installations)
      cumNC += safe(r.nc_installations)
      const cRma = safe(r.compliant_rma)
      const ncRma = safe(r.nc_rma)
      return {
        ...r,
        cum_compliant_inst: cumC,
        cum_nc_inst: cumNC,
        compliant_dppm: cumC > 0 ? Math.round((cRma / cumC) * 1e6) : 0,
        nc_dppm: cumNC > 0 ? Math.round((ncRma / cumNC) * 1e6) : 0,
        compliant_rma_rate: cumC > 0 ? Number(((cRma / cumC) * 100).toFixed(4)) : 0,
        nc_rma_rate: cumNC > 0 ? Number(((ncRma / cumNC) * 100).toFixed(4)) : 0,
      }
    })
  }, [trendData])

  // Dynamic insight generator — uses cumulative DPPM from the latest period
  const trendInsight = useMemo(() => {
    if (sortedTrend.length === 0) return null
    const totals = sortedTrend.reduce(
      (acc, r) => ({
        cRma: acc.cRma + safe(r.compliant_rma),
        ncRma: acc.ncRma + safe(r.nc_rma),
      }),
      { cRma: 0, ncRma: 0 },
    )
    const last = sortedTrend[sortedTrend.length - 1]
    const cumCInst = last.cum_compliant_inst
    const cumNCInst = last.cum_nc_inst
    const totalInst = cumCInst + cumNCInst
    const totalRma = totals.cRma + totals.ncRma
    if (totalInst === 0 || totalRma === 0) return null

    const ncInstPct = ((cumNCInst / totalInst) * 100).toFixed(1)
    const ncRmaPct = ((totals.ncRma / totalRma) * 100).toFixed(1)
    const cDppm = cumCInst > 0 ? Math.round((totals.cRma / cumCInst) * 1e6).toLocaleString() : '0'
    const ncDppm = cumNCInst > 0 ? Math.round((totals.ncRma / cumNCInst) * 1e6).toLocaleString() : '0'

    const ncHigher = Number(ncDppm.replace(/,/g, '')) > Number(cDppm.replace(/,/g, ''))
    if (ncHigher) {
      return `Non-compliant systems represented ${ncInstPct}% of cumulative installations but ${ncRmaPct}% of total RMA requests, resulting in a higher cumulative DPPM (${ncDppm}) compared to compliant systems (${cDppm}).`
    }
    return `Although non-compliant systems represented ${ncInstPct}% of cumulative installations and ${ncRmaPct}% of RMA requests, compliant systems had a comparable or higher cumulative DPPM (${cDppm}) versus non-compliant (${ncDppm}).`
  }, [sortedTrend])

  // ─── Export handlers ───────────────────────────────────────────────────────

  const exportCat1 = useCallback(() => {
    if (!cat1Rows) return
    downloadCsv('compliance_circuit_phase.csv',
      ['site_id', 'country', 'tss_region', 'state', 'city', 'product_type', 'model_name', 'circuit_phase', 'pv_module_make', 'unit_count'],
      cat1Rows as unknown as Record<string, unknown>[])
  }, [cat1Rows])

  const exportCat2 = useCallback(() => {
    if (!cat2Rows) return
    downloadCsv('compliance_three_phase.csv',
      ['site_id', 'country', 'tss_region', 'state', 'city', 'product_type', 'model_name', 'production_eim_config', 'consumption_eim_config', 'pv_module_make', 'unit_count'],
      cat2Rows as unknown as Record<string, unknown>[])
  }, [cat2Rows])

  const exportCat3 = useCallback(() => {
    if (!cat3Rows) return
    downloadCsv('compliance_module_limits.csv',
      ['site_id', 'country', 'tss_region', 'state', 'city', 'product_type', 'model_name', 'pv_module_make', 'pv_module_model', 'voc', 'isc', 'voc_at_temp', 'isc_at_temp', 'max_voc', 'max_isc', 'voc_exceeded', 'isc_exceeded', 'unit_count'],
      cat3Rows as unknown as Record<string, unknown>[])
  }, [cat3Rows])

  // ─── Loading / Error states ────────────────────────────────────────────────

  if (fleetLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading fleet data...
      </div>
    )
  }

  if (fleetError) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" /> {fleetError.message}
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className="h-7 w-7 text-red-500" />
          <div>
            <h1 className="text-2xl font-bold">Compliance Check</h1>
            <p className="text-sm text-muted-foreground">
              Systems with non-compatible configurations across Circuit Phase, EIM Phase, and Module Electrical limits
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="cursor-pointer py-3" onClick={() => setExpanded(!expanded)}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Filters</CardTitle>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        </CardHeader>
        {expanded && (
          <CardContent className="flex flex-wrap gap-4 pt-0">
            <MultiSelectDropdown
              label="Quarter"
              options={(quarters ?? []).map((r) => r.quarter).filter(Boolean)}
              selected={selQuarters}
              onChange={setSelQuarters}
            />
            <MultiSelectDropdown
              label="Region"
              options={(regions ?? []).map((r) => r.tss_region).filter(Boolean)}
              selected={selRegions}
              onChange={setSelRegions}
              formatLabel={tssRegionLabel}
            />
            <MultiSelectDropdown
              label="Product Type"
              options={(products ?? []).map((r) => r.product_type).filter(Boolean)}
              selected={selProducts}
              onChange={setSelProducts}
            />
          </CardContent>
        )}
      </Card>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <KPICard
          label="208 L-L Violations"
          value={s ? `${fmt(s.cat1_sites)} sites` : '—'}
          delta={s ? `${fmt(s.cat1_units)} units affected` : ''}
          icon={PlugZap}
        />
        <KPICard
          label="Three-Phase Violations"
          value={s ? `${fmt(s.cat2_sites)} sites` : '—'}
          delta={s ? `${fmt(s.cat2_units)} units affected` : ''}
          icon={Zap}
        />
        <KPICard
          label="Module Compatibility Violations"
          value={activeTab === 'module_limits' ? `${fmt(cat3Sites)} sites` : '—'}
          delta={activeTab === 'module_limits' ? `${fmt(cat3Units)} units affected` : 'Select tab to load'}
          icon={ThermometerSun}
        />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ComplianceTab)}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="circuit_phase" className="gap-2">
            <PlugZap className="h-3.5 w-3.5" />
            208 L-L
            {s && safe(s.cat1_sites) > 0 && (
              <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(s.cat1_sites)} sites</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="three_phase" className="gap-2">
            <Zap className="h-3.5 w-3.5" />
            Three-Phase
            {s && safe(s.cat2_sites) > 0 && (
              <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(s.cat2_sites)} sites</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="module_limits" className="gap-2">
            <ThermometerSun className="h-3.5 w-3.5" />
            Module Compatibility
            {cat3Sites > 0 && (
              <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(cat3Sites)} sites</Badge>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Tab Content */}
      {activeTab === 'circuit_phase' && (
        <ComplianceSection
          title="Category 1: 208 L-L Violation (NA Only)"
          description="These microinverter models are not permitted on SinglePhase (208 L-L) circuit systems in North America."
          loading={cat1Loading}
          rows={cat1Rows as unknown as Record<string, unknown>[]}
          exportFn={exportCat1}
          columns={[
            { key: 'site_id', label: 'Site ID', link: (v: unknown) => `${ENLIGHTEN_BASE}${v}` },
            { key: 'state', label: 'State' },
            { key: 'city', label: 'City' },
            { key: 'product_type', label: 'Product Type' },
            { key: 'model_name', label: 'Model Name' },
            { key: 'circuit_phase', label: 'Circuit Phase' },
            { key: 'pv_module_make', label: 'Module Make' },
            { key: 'unit_count', label: 'Units', align: 'right' },
          ]}
        />
      )}

      {activeTab === 'three_phase' && (
        <ComplianceSection
          title="Category 2: Three-Phase Violation (NA Only)"
          description='These microinverter models should not be connected to three-phase systems (Production or Consumption EIM Config starting with "Three").'
          loading={cat2Loading}
          rows={cat2Rows as unknown as Record<string, unknown>[]}
          exportFn={exportCat2}
          columns={[
            { key: 'site_id', label: 'Site ID', link: (v: unknown) => `${ENLIGHTEN_BASE}${v}` },
            { key: 'state', label: 'State' },
            { key: 'city', label: 'City' },
            { key: 'product_type', label: 'Product Type' },
            { key: 'model_name', label: 'Model Name' },
            { key: 'production_eim_config', label: 'Prod EIM' },
            { key: 'consumption_eim_config', label: 'Cons EIM' },
            { key: 'pv_module_make', label: 'Module Make' },
            { key: 'unit_count', label: 'Units', align: 'right' },
          ]}
        />
      )}

      {activeTab === 'module_limits' && (
        <>
          {/* ── Temperature & violation filter ── */}
          <Card>
            <CardContent className="pt-5 pb-4 space-y-4">
              {/* Temperature row */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Low Temp (°C) — for Voc</label>
                  <Input
                    type="number"
                    value={lowTemp}
                    onChange={(e) => setLowTemp(e.target.value)}
                    className="h-9 w-24 tabular-nums text-center"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">High Temp (°C) — for Isc</label>
                  <Input
                    type="number"
                    value={highTemp}
                    onChange={(e) => setHighTemp(e.target.value)}
                    className="h-9 w-24 tabular-nums text-center"
                  />
                </div>
                <Button size="sm" onClick={handleApplyTemp} disabled={!tempDirty}>
                  Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetTemp} disabled={isDefaultTemp} className="gap-1">
                  <RotateCcw className="h-3.5 w-3.5" /> Reset
                </Button>
                {!isDefaultTemp && (
                  <span className="text-xs text-muted-foreground">
                    Evaluating at Voc@{appliedLowTemp}\u00B0C, Isc@{appliedHighTemp}\u00B0C
                  </span>
                )}
              </div>

              {/* Violation type filter chips */}
              {cat3Count > 0 && (
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">Filter by violation type</span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setViolationFilter('all')}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        violationFilter === 'all'
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border hover:bg-muted'
                      }`}
                    >
                      All
                      <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">{fmt(cat3Count)}</Badge>
                    </button>
                    <button
                      onClick={() => setViolationFilter('voc_only')}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        violationFilter === 'voc_only'
                          ? 'border-red-500 bg-red-500 text-white'
                          : 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950'
                      }`}
                    >
                      Voc exceeded
                      <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(cat3VocOnly.length)}</Badge>
                    </button>
                    <button
                      onClick={() => setViolationFilter('isc_only')}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        violationFilter === 'isc_only'
                          ? 'border-orange-500 bg-orange-500 text-white'
                          : 'border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-950'
                      }`}
                    >
                      Isc exceeded
                      <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(cat3IscOnly.length)}</Badge>
                    </button>
                    <button
                      onClick={() => setViolationFilter('both')}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        violationFilter === 'both'
                          ? 'border-purple-500 bg-purple-500 text-white'
                          : 'border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-950'
                      }`}
                    >
                      Both exceeded
                      <Badge variant="destructive" className="ml-1 text-[10px] px-1.5 py-0">{fmt(cat3BothArr.length)}</Badge>
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {fmt(cat3Sites)} distinct sites \u00B7 {fmt(cat3Units)} total units affected
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <ComplianceSection
            title="Category 3: Module Compatibility Violations (All Regions)"
            description={`Modules whose Voc@${appliedLowTemp}°C or Isc@${appliedHighTemp}°C exceed the paired microinverter’s max ratings.`}
            loading={cat3Loading}
            rows={filteredCat3 as unknown as Record<string, unknown>[] | undefined}
            exportFn={exportCat3}
            columns={[
              { key: 'site_id', label: 'Site ID', link: (v: unknown) => `${ENLIGHTEN_BASE}${v}` },
              { key: 'tss_region', label: 'Region', format: (v: unknown) => tssRegionLabel(String(v ?? '')) },
              { key: 'country', label: 'Country' },
              { key: 'product_type', label: 'Product' },
              { key: 'model_name', label: 'Model' },
              { key: 'pv_module_model', label: 'Module' },
              { key: 'voc', label: 'Voc (STC)', align: 'right', format: (v: unknown) => safe(v).toFixed(2) },
              { key: 'voc_at_temp', label: `Voc@${appliedLowTemp}\u00B0C`, align: 'right', format: (v: unknown) => safe(v).toFixed(2), flag: 'voc_exceeded' },
              { key: 'max_voc', label: 'Max Voc', align: 'right' },
              { key: 'isc', label: 'Isc (STC)', align: 'right', format: (v: unknown) => safe(v).toFixed(3) },
              { key: 'isc_at_temp', label: `Isc@${appliedHighTemp}\u00B0C`, align: 'right', format: (v: unknown) => safe(v).toFixed(3), flag: 'isc_exceeded' },
              { key: 'max_isc', label: 'Max Isc', align: 'right' },
              { key: 'unit_count', label: 'Units', align: 'right' },
            ]}
          />
        </>
      )}

      {/* ─── RMA Correlation ─────────────────────────────────────────── */}
      {isRmaLoading && (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading RMA data...
          </CardContent>
        </Card>
      )}
      {isRmaLoaded && (
        <Card className="border-amber-200 dark:border-amber-800">
          <CardHeader className="cursor-pointer py-3" onClick={() => setRmaExpanded(!rmaExpanded)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-5 w-5 text-amber-600" />
                <CardTitle className="text-base">RMA Correlation</CardTitle>
                <span className="text-xs text-muted-foreground">
                  Compliance violations correlated with microinverter replacements (Aug 2023 – Aug 2026)
                </span>
              </div>
              {rmaExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </CardHeader>
          <CardContent className={rmaExpanded ? 'space-y-4' : 'hidden'}>
            {/* Mode selector */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">Show RMA data for sites failing</span>
              <div className="flex flex-wrap gap-2">
                {([
                  { mode: 'all' as const, label: 'All Categories', desc: 'Sites failing at least one compliance check' },
                  { mode: 'cat1' as const, label: '208 L-L Only', desc: 'Only 208 L-L violations' },
                  { mode: 'cat2' as const, label: 'Three-Phase Only', desc: 'Only Three-Phase violations' },
                  { mode: 'cat3' as const, label: 'Module Compat Only', desc: 'Only Module Compatibility violations' },
                ]).map(({ mode, label, desc }) => (
                  <button
                    key={mode}
                    onClick={() => setRmaMode(mode)}
                    title={desc}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      rmaMode === mode
                        ? 'border-amber-500 bg-amber-500 text-white'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* RMA KPI row */}
            {rmaCorrLoading ? (
              <div className="flex items-center gap-2 py-4 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Calculating correlation...
              </div>
            ) : rc ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">Violation Sites</p>
                  <p className="text-lg font-bold">{fmt(rc.violation_sites)}</p>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">Sites with RMAs</p>
                  <p className="text-lg font-bold">{fmt(rc.sites_with_rma)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {safe(rc.violation_sites) > 0 ? `${((safe(rc.sites_with_rma) / safe(rc.violation_sites)) * 100).toFixed(1)}% of violation sites` : '—'}
                  </p>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">Total RMAs</p>
                  <p className="text-lg font-bold">{fmt(rc.total_rmas)}</p>
                </div>
                <div className="rounded-lg border bg-card p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">Units Affected</p>
                  <p className="text-lg font-bold">{fmt(rc.units_affected)}</p>
                </div>
                <div className="rounded-lg border bg-amber-50 dark:bg-amber-950 p-3 text-center">
                  <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">DPPM</p>
                  <p className="text-lg font-bold text-amber-700 dark:text-amber-300">{fmt(rc.dppm)}</p>
                  <p className="text-[10px] text-amber-600 dark:text-amber-400">
                    <TrendingDown className="inline h-3 w-3 mr-0.5" />
                    Total RMAs / Units Affected × 1M
                  </p>
                </div>
              </div>
            ) : null}

            {/* RMA detail table */}
            {rmaExpanded && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Sites with violations and RMA replacements {rmaDetailWithRma.length > 0 && `(${fmt(rmaDetailWithRma.length)} sites)`}
                  </span>
                  <Button variant="outline" size="sm" onClick={exportRmaDetail} disabled={rmaDetailWithRma.length === 0} title="Export to CSV">
                    <Download className="h-3.5 w-3.5 mr-1" /> CSV
                  </Button>
                </div>
                {rmaDetailLoading ? (
                  <div className="flex items-center gap-2 py-4 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading detail...
                  </div>
                ) : rmaDetailWithRma.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 py-6 text-emerald-600 dark:text-emerald-400">
                    <ShieldAlert className="h-5 w-5" />
                    <span className="font-medium">No RMA replacements found at violation sites.</span>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <div className="max-h-[400px] overflow-y-auto">
                      <Table className="min-w-[1400px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Site ID</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead>Country</TableHead>
                            <TableHead>Product Type</TableHead>
                            <TableHead>Returned SKU</TableHead>
                            <TableHead>Replacement SKU</TableHead>
                            <TableHead className="text-right">Fleet Units</TableHead>
                            <TableHead className="text-right">RMA Count</TableHead>
                            <TableHead>Module Model</TableHead>
                            <TableHead className="text-right">Voc</TableHead>
                            <TableHead className="text-right">Voc@{appliedLowTemp}&deg;C</TableHead>
                            <TableHead className="text-right">Isc</TableHead>
                            <TableHead className="text-right">Isc@{appliedHighTemp}&deg;C</TableHead>
                            <TableHead>Violations</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rmaDetailWithRma.slice(0, 200).map((row, idx) => (
                            <TableRow key={idx}>
                              <TableCell>
                                <a href={`${ENLIGHTEN_BASE}${row.site_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                                  {row.site_id}
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </TableCell>
                              <TableCell>{row.state}</TableCell>
                              <TableCell>{row.country}</TableCell>
                              <TableCell>{row.product_type}</TableCell>
                              <TableCell className="text-xs max-w-[180px] truncate" title={row.returned_sku ?? ''}>{row.returned_sku ?? '—'}</TableCell>
                              <TableCell className="text-xs max-w-[180px] truncate" title={row.replacement_sku ?? ''}>{row.replacement_sku ?? '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmt(row.fleet_units)}</TableCell>
                              <TableCell className="text-right tabular-nums font-semibold">{fmt(row.rma_count)}</TableCell>
                              <TableCell className="text-xs">{row.pv_module_model ?? '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.voc != null ? safe(row.voc).toFixed(2) : '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.voc_at_temp != null ? safe(row.voc_at_temp).toFixed(2) : '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.isc != null ? safe(row.isc).toFixed(3) : '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{row.isc_at_temp != null ? safe(row.isc_at_temp).toFixed(3) : '—'}</TableCell>
                              <TableCell>
                                <div className="flex gap-1">
                                  {safe(row.cat1_fail) === 1 && <Badge variant="destructive" className="text-[9px] px-1 py-0">208 L-L</Badge>}
                                  {safe(row.cat2_fail) === 1 && <Badge variant="destructive" className="text-[9px] px-1 py-0">3-Phase</Badge>}
                                  {safe(row.cat3_fail) === 1 && <Badge variant="destructive" className="text-[9px] px-1 py-0">Module</Badge>}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Section 3: Installation vs RMA Trend ─────────────────────── */}
      {isRmaLoaded && (
        <Card className="border-sky-200 dark:border-sky-800">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-sky-600" />
              <div>
                <CardTitle className="text-base">Installation vs RMA Trend — Compliance Comparison</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Half-year comparison of installation population and mapped RMA requests for compliant and non-compliant systems
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Category filter */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">Compliance Category</span>
              <div className="flex flex-wrap gap-2">
                {([
                  { cat: 'all' as const, label: 'All' },
                  { cat: 'cat1' as const, label: '208 L-L Violations' },
                  { cat: 'cat2' as const, label: 'Three-Phase Violations' },
                  { cat: 'cat3' as const, label: 'Module Compatibility Violations' },
                ]).map(({ cat, label }) => (
                  <button
                    key={cat}
                    onClick={() => setTrendCategory(cat)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      trendCategory === cat
                        ? 'border-sky-500 bg-sky-500 text-white'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {trendLoading ? (
              <div className="flex items-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Building trend data...
              </div>
            ) : sortedTrend.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <ShieldAlert className="h-5 w-5" />
                <span>No trend data available for the selected filters.</span>
              </div>
            ) : (
              <>
                <ReactECharts
                  style={{ height: 420 }}
                  option={{
                    tooltip: {
                      trigger: 'axis',
                      axisPointer: { type: 'cross' },
                      formatter: (params: Array<{ seriesName: string; value: number; axisValueLabel: string; marker: string }>) => {
                        if (!Array.isArray(params) || params.length === 0) return ''
                        const hy = params[0].axisValueLabel
                        const row = sortedTrend.find((r) => r.half_year === hy)
                        if (!row) return hy

                        const cInst = safe(row.compliant_installations)
                        const ncInst = safe(row.nc_installations)
                        const cRma = safe(row.compliant_rma)
                        const ncRma = safe(row.nc_rma)
                        const cumCInst = row.cum_compliant_inst
                        const cumNCInst = row.cum_nc_inst
                        const cDppm = row.compliant_dppm.toLocaleString()
                        const ncDppm = row.nc_dppm.toLocaleString()
                        const cRate = cumCInst > 0 ? ((cRma / cumCInst) * 100).toFixed(3) : '0.000'
                        const ncRate = cumNCInst > 0 ? ((ncRma / cumNCInst) * 100).toFixed(3) : '0.000'

                        return `<div style="min-width:300px">
                          <div style="font-weight:600;margin-bottom:6px">${hy}${hy === 'H2-26' ? ' *' : ''}</div>
                          <div style="margin-bottom:6px">
                            <div style="font-weight:600;color:#22c55e;margin-bottom:2px">Compliant</div>
                            <div>Installations (period): <b>${cInst.toLocaleString()}</b></div>
                            <div>Cumulative Installations: <b>${cumCInst.toLocaleString()}</b></div>
                            <div>RMA Requests: <b>${cRma.toLocaleString()}</b></div>
                            <div>RMA Rate: <b>${cRate}%</b></div>
                            <div>DPPM: <b>${cDppm}</b></div>
                          </div>
                          <div>
                            <div style="font-weight:600;color:#ef4444;margin-bottom:2px">Non-Compliant</div>
                            <div>Installations (period): <b>${ncInst.toLocaleString()}</b></div>
                            <div>Cumulative Installations: <b>${cumNCInst.toLocaleString()}</b></div>
                            <div>RMA Requests: <b>${ncRma.toLocaleString()}</b></div>
                            <div>RMA Rate: <b>${ncRate}%</b></div>
                            <div>DPPM: <b>${ncDppm}</b></div>
                          </div>
                        </div>`
                      },
                    },
                    legend: {
                      data: [
                        'Compliant Installations', 'Non-Compliant Installations',
                        'Compliant DPPM', 'Non-Compliant DPPM',
                      ],
                      bottom: 0,
                      textStyle: { fontSize: 11 },
                    },
                    grid: { left: 70, right: 70, top: 40, bottom: 60 },
                    xAxis: {
                      type: 'category',
                      data: sortedTrend.map((r) => r.half_year),
                      axisLabel: {
                        formatter: (v: string) => v === 'H2-26' ? 'H2-26*' : v,
                      },
                    },
                    yAxis: [
                      {
                        type: 'value',
                        name: 'Installations',
                        nameTextStyle: { fontSize: 11 },
                        axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v) },
                      },
                      {
                        type: 'value',
                        name: 'DPPM',
                        nameTextStyle: { fontSize: 11 },
                        axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v) },
                      },
                    ],
                    series: [
                      {
                        name: 'Compliant Installations',
                        type: 'bar',
                        data: sortedTrend.map((r) => safe(r.compliant_installations)),
                        itemStyle: { color: '#86efac' },
                        barGap: '10%',
                      },
                      {
                        name: 'Non-Compliant Installations',
                        type: 'bar',
                        data: sortedTrend.map((r) => safe(r.nc_installations)),
                        itemStyle: { color: '#fca5a5' },
                      },
                      {
                        name: 'Compliant DPPM',
                        type: 'line',
                        yAxisIndex: 1,
                        data: sortedTrend.map((r) => r.compliant_dppm),
                        lineStyle: { color: '#16a34a', width: 2 },
                        itemStyle: { color: '#16a34a' },
                        symbol: 'circle',
                        symbolSize: 7,
                      },
                      {
                        name: 'Non-Compliant DPPM',
                        type: 'line',
                        yAxisIndex: 1,
                        data: sortedTrend.map((r) => r.nc_dppm),
                        lineStyle: { color: '#dc2626', width: 2 },
                        itemStyle: { color: '#dc2626' },
                        symbol: 'circle',
                        symbolSize: 7,
                      },
                    ],
                  }}
                />

                <p className="text-[10px] text-muted-foreground text-right italic">
                  * H2-26 data through August 2026
                </p>

                {/* Dynamic insight */}
                {trendInsight && (
                  <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 dark:border-sky-800 dark:bg-sky-950">
                    <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-sky-600 dark:text-sky-400" />
                    <p className="text-xs text-sky-800 dark:text-sky-300">
                      <span className="font-semibold">RMA Insight: </span>
                      {trendInsight}
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Reusable compliance detail section ──────────────────────────────────────

interface ColumnDef {
  key: string
  label: string
  align?: 'left' | 'right'
  format?: (val: unknown) => string
  flag?: string
  link?: (val: unknown) => string
}

function ComplianceSection({
  title,
  description,
  loading,
  rows,
  exportFn,
  columns,
}: {
  title: string
  description: string
  loading: boolean
  rows: Record<string, unknown>[] | undefined
  exportFn: () => void
  columns: ColumnDef[]
}) {
  const PAGE_SIZE = 100
  const [page, setPage] = useState(0)

  const pagedRows = useMemo(() => {
    if (!rows) return []
    return rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  }, [rows, page])

  const totalPages = rows ? Math.ceil(rows.length / PAGE_SIZE) : 0

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading compliance data...
        </CardContent>
      </Card>
    )
  }

  const total = rows?.length ?? 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <div className="flex items-center gap-2">
            {total > 0 && (
              <Badge variant="secondary" className="text-xs">
                {fmt(total)} row{total !== 1 ? 's' : ''}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={exportFn} disabled={total === 0} title="Export violations to CSV">
              <Download className="h-3.5 w-3.5 mr-1" /> CSV
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-emerald-600 dark:text-emerald-400">
            <ShieldAlert className="h-5 w-5" />
            <span className="font-medium">No violations found for the selected filters.</span>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <div className="max-h-[600px] overflow-y-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    {columns.map((col) => (
                      <TableHead key={col.key} className={col.align === 'right' ? 'text-right' : ''}>
                        {col.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedRows.map((row, idx) => (
                    <TableRow key={idx}>
                      {columns.map((col) => {
                        const raw = row[col.key]
                        const display = col.format ? col.format(raw) : (raw == null ? '' : String(raw))
                        const flagged = col.flag ? safe(row[col.flag]) === 1 : false
                        const href = col.link ? col.link(raw) : null
                        return (
                          <TableCell
                            key={col.key}
                            className={`${col.align === 'right' ? 'text-right tabular-nums' : ''} ${flagged ? 'bg-red-50 text-red-700 font-semibold dark:bg-red-950 dark:text-red-400' : ''}`}
                          >
                            {href ? (
                              <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400">
                                {display}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : display}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </div>

            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {fmt(total)}
                </span>
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Prev
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
