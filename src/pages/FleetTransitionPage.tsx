import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Loader2, TrendingUp, TrendingDown, ArrowRight, Lightbulb, Layers,
  Zap, Ratio, Package, Factory, BarChart3, LayoutGrid, Combine,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import KPICard from '@/components/layout/KPICard'
import BarChart from '@/components/charts/BarChart'
import MultiSelectDropdown from '@/components/filters/MultiSelectDropdown'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useFleetStore } from '@/store/fleetStore'
import { query } from '@/lib/duckdb'
import {
  buildFleetFilter,
  FLEET_DISTINCT_TSS_REGIONS, FLEET_DISTINCT_TSS_COUNTRIES,
  FLEET_DISTINCT_QUARTERS,
  timeBucketExpr,
  FLEET_TRANSITION_WAFER,
  FLEET_TRANSITION_POWER,
  FLEET_TRANSITION_DCAC,
  FLEET_TRANSITION_PRODUCT_TYPE,
  FLEET_TRANSITION_MODULE_MAKE,
  FLEET_TRANSITION_POWER_BUCKET,
  FLEET_TRANSITION_GROWTH,
} from '@/lib/fleetQueries'
import { WAFER_ORDER, WAFER_COLORS, tssRegionLabel } from '@/lib/fleetRegions'
import type { EChartsOption } from 'echarts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type TimeResolution = 'quarterly' | 'half-yearly' | 'yearly'
type MetricTab = 'wafer' | 'power' | 'dcac' | 'product' | 'module_make' | 'power_bucket'
type ViewMode = 'combined' | 'individual'

interface WaferRow { period: string; tss_region: string; module_wafer: string; units: number }
interface PowerRow { period: string; tss_region: string; avg_power_w: number; median_power_w: number; units: number }
interface DcacRow { period: string; tss_region: string; avg_dc_ac: number; median_dc_ac: number; units: number }
interface ProductRow { period: string; tss_region: string; product_type: string; units: number }
interface MakeRow { period: string; tss_region: string; pv_module_make: string; units: number }
interface BucketRow { period: string; tss_region: string; power_bucket: string; units: number }
interface GrowthRow { period: string; tss_region: string; total_units: number; total_sites: number; total_mwdc: number; total_mwac: number }

/** Aggregate rows across regions by summing numeric fields (for combined mode) */
function aggregateByPeriod<T extends { period: string; tss_region: string }>(rows: T[], sumKeys: (keyof T)[]): Omit<T, 'tss_region'>[] {
  const map = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const key = String(r.period) + '||' + Object.keys(r).filter(k => k !== 'period' && k !== 'tss_region' && !sumKeys.includes(k as keyof T)).map(k => String((r as Record<string, unknown>)[k])).join('||')
    if (!map.has(key)) {
      const entry: Record<string, unknown> = { ...r }
      delete entry.tss_region
      map.set(key, entry)
    } else {
      const entry = map.get(key)!
      for (const sk of sumKeys) entry[sk as string] = safe(entry[sk as string]) + safe(r[sk])
    }
  }
  return Array.from(map.values()) as Omit<T, 'tss_region'>[]
}

function aggregateGrowth(rows: GrowthRow[]): Omit<GrowthRow, 'tss_region'>[] {
  const map = new Map<string, Omit<GrowthRow, 'tss_region'>>()
  for (const r of rows) {
    const p = String(r.period)
    if (!map.has(p)) {
      map.set(p, { period: p, total_units: safe(r.total_units), total_sites: safe(r.total_sites), total_mwdc: safe(r.total_mwdc), total_mwac: safe(r.total_mwac) })
    } else {
      const e = map.get(p)!
      e.total_units += safe(r.total_units)
      e.total_sites += safe(r.total_sites)
      e.total_mwdc += safe(r.total_mwdc)
      e.total_mwac += safe(r.total_mwac)
    }
  }
  return Array.from(map.values())
}

function aggregatePower(rows: PowerRow[]): Omit<PowerRow, 'tss_region'>[] {
  const map = new Map<string, { period: string; totalWU: number; totalU: number; medians: number[] }>()
  for (const r of rows) {
    const p = String(r.period)
    if (!map.has(p)) map.set(p, { period: p, totalWU: 0, totalU: 0, medians: [] })
    const e = map.get(p)!
    e.totalWU += safe(r.avg_power_w) * safe(r.units)
    e.totalU += safe(r.units)
    e.medians.push(safe(r.median_power_w))
  }
  return Array.from(map.values()).map(e => ({
    period: e.period,
    avg_power_w: e.totalU > 0 ? e.totalWU / e.totalU : 0,
    median_power_w: e.medians.length > 0 ? e.medians.reduce((a, b) => a + b, 0) / e.medians.length : 0,
    units: e.totalU,
  }))
}

function aggregateDcac(rows: DcacRow[]): Omit<DcacRow, 'tss_region'>[] {
  const map = new Map<string, { period: string; totalDU: number; totalU: number; medians: number[] }>()
  for (const r of rows) {
    const p = String(r.period)
    if (!map.has(p)) map.set(p, { period: p, totalDU: 0, totalU: 0, medians: [] })
    const e = map.get(p)!
    e.totalDU += safe(r.avg_dc_ac) * safe(r.units)
    e.totalU += safe(r.units)
    e.medians.push(safe(r.median_dc_ac))
  }
  return Array.from(map.values()).map(e => ({
    period: e.period,
    avg_dc_ac: e.totalU > 0 ? e.totalDU / e.totalU : 0,
    median_dc_ac: e.medians.length > 0 ? e.medians.reduce((a, b) => a + b, 0) / e.medians.length : 0,
    units: e.totalU,
  }))
}

function safe(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? v : 0
}

function fmt(n: unknown, digits = 0): string {
  const v = safe(n)
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

function pctChange(a: number, b: number): { label: string; type: 'positive' | 'negative' | 'neutral' } {
  if (!a || !b) return { label: '—', type: 'neutral' }
  const pct = ((b - a) / Math.abs(a)) * 100
  const sign = pct > 0 ? '+' : ''
  return {
    label: `${sign}${pct.toFixed(1)}%`,
    type: pct > 1 ? 'positive' : pct < -1 ? 'negative' : 'neutral',
  }
}

// Distinct saturated colors for product types / module makes
const SERIES_COLORS = [
  '#2563EB', '#059669', '#D97706', '#C026D3', '#DC2626',
  '#0891B2', '#7C3AED', '#EA580C', '#16A34A', '#DB2777',
  '#4F46E5', '#CA8A04', '#0D9488', '#E11D48', '#6D28D9',
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function FleetTransitionPage() {
  const { isLoading: fleetLoading } = useEnsureFleetData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)

  // Local state — independent from global fleet store so this page doesn't
  // interfere with other Fleet pages' filters
  const [selectedTssRegions, setSelectedTssRegions] = useState<string[]>([])
  const [selectedTssCountries, setSelectedTssCountries] = useState<string[]>([])
  const [resolution, setResolution] = useState<TimeResolution>('quarterly')
  const [activeTab, setActiveTab] = useState<MetricTab>('wafer')
  const [viewMode, setViewMode] = useState<ViewMode>('combined')

  const multiSelected = selectedTssRegions.length + selectedTssCountries.length >= 2

  // Fetch filter options
  const { data: allRegions } = useQuery({
    queryKey: ['fleet-transition-tss-regions'],
    queryFn: () => query<{ tss_region: string }>(FLEET_DISTINCT_TSS_REGIONS),
    enabled: isFleetLoaded,
  })
  const regionOptions = useMemo(
    () => (allRegions ?? []).map((r) => r.tss_region).filter(Boolean),
    [allRegions],
  )

  const { data: allCountries } = useQuery({
    queryKey: ['fleet-transition-tss-countries', selectedTssRegions],
    queryFn: () => query<{ tss_country: string }>(FLEET_DISTINCT_TSS_COUNTRIES(selectedTssRegions)),
    enabled: isFleetLoaded,
  })
  const countryOptions = useMemo(
    () => (allCountries ?? []).map((c) => c.tss_country).filter(Boolean),
    [allCountries],
  )

  const { data: allQuarters } = useQuery({
    queryKey: ['fleet-transition-quarters'],
    queryFn: () => query<{ quarter: string }>(FLEET_DISTINCT_QUARTERS),
    enabled: isFleetLoaded,
  })

  // Build WHERE clause
  const where = useMemo(
    () => buildFleetFilter({ tssRegions: selectedTssRegions, tssCountries: selectedTssCountries }),
    [selectedTssRegions, selectedTssCountries],
  )
  const bucket = useMemo(() => timeBucketExpr(resolution), [resolution])

  // ---- Data queries ----
  const { data: waferData, isLoading: waferLoading } = useQuery({
    queryKey: ['fleet-tr-wafer', where, bucket],
    queryFn: () => query<WaferRow>(FLEET_TRANSITION_WAFER(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: powerData, isLoading: powerLoading } = useQuery({
    queryKey: ['fleet-tr-power', where, bucket],
    queryFn: () => query<PowerRow>(FLEET_TRANSITION_POWER(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: dcacData, isLoading: dcacLoading } = useQuery({
    queryKey: ['fleet-tr-dcac', where, bucket],
    queryFn: () => query<DcacRow>(FLEET_TRANSITION_DCAC(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: productData, isLoading: productLoading } = useQuery({
    queryKey: ['fleet-tr-product', where, bucket],
    queryFn: () => query<ProductRow>(FLEET_TRANSITION_PRODUCT_TYPE(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: makeData, isLoading: makeLoading } = useQuery({
    queryKey: ['fleet-tr-make', where, bucket],
    queryFn: () => query<MakeRow>(FLEET_TRANSITION_MODULE_MAKE(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: bucketData, isLoading: bucketLoading } = useQuery({
    queryKey: ['fleet-tr-bucket', where, bucket],
    queryFn: () => query<BucketRow>(FLEET_TRANSITION_POWER_BUCKET(where, bucket)),
    enabled: isFleetLoaded,
  })
  const { data: growthData, isLoading: growthLoading } = useQuery({
    queryKey: ['fleet-tr-growth', where, bucket],
    queryFn: () => query<GrowthRow>(FLEET_TRANSITION_GROWTH(where, bucket)),
    enabled: isFleetLoaded,
  })

  // ---- Aggregate for combined mode ----
  const aggWafer = useMemo(() => waferData ? aggregateByPeriod(waferData, ['units']) as { period: string; module_wafer: string; units: number }[] : [], [waferData])
  const aggPower = useMemo(() => powerData ? aggregatePower(powerData) : [], [powerData])
  const aggDcac = useMemo(() => dcacData ? aggregateDcac(dcacData) : [], [dcacData])
  const aggProduct = useMemo(() => productData ? aggregateByPeriod(productData, ['units']) as { period: string; product_type: string; units: number }[] : [], [productData])
  const aggMake = useMemo(() => makeData ? aggregateByPeriod(makeData, ['units']) as { period: string; pv_module_make: string; units: number }[] : [], [makeData])
  const aggBucket = useMemo(() => bucketData ? aggregateByPeriod(bucketData, ['units']) as { period: string; power_bucket: string; units: number }[] : [], [bucketData])
  const aggGrowth = useMemo(() => growthData ? aggregateGrowth(growthData) : [], [growthData])

  // Distinct regions present in data (for individual mode)
  const dataRegions = useMemo(() => {
    const set = new Set<string>()
    ;(waferData ?? []).forEach((r) => { if (r.tss_region) set.add(r.tss_region) })
    ;(growthData ?? []).forEach((r) => { if (r.tss_region) set.add(r.tss_region) })
    return Array.from(set).sort()
  }, [waferData, growthData])

  // ---- Derived: periods sorted ----
  const periods = useMemo(() => {
    const set = new Set<string>()
    ;(aggWafer).forEach((r) => set.add(String(r.period)))
    ;(aggGrowth).forEach((r) => set.add(String(r.period)))
    return Array.from(set).sort()
  }, [aggWafer, aggGrowth])

  // ---- KPI computations (always combined) ----
  const kpis = useMemo(() => {
    if (!aggGrowth.length) return null
    const sorted = [...aggGrowth].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const totalUnits = sorted.reduce((s, r) => s + safe(r.total_units), 0)
    const totalMwdc = sorted.reduce((s, r) => s + safe(r.total_mwdc), 0)

    const unitsDelta = pctChange(safe(first.total_units), safe(last.total_units))
    const sitesDelta = pctChange(safe(first.total_sites), safe(last.total_sites))

    // Power trend
    const pSorted = [...aggPower].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    const firstPower = pSorted[0]
    const lastPower = pSorted[pSorted.length - 1]
    const powerDelta = firstPower && lastPower
      ? pctChange(safe(firstPower.avg_power_w), safe(lastPower.avg_power_w))
      : { label: '—', type: 'neutral' as const }

    // DC/AC trend
    const dSorted = [...aggDcac].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    const firstDcac = dSorted[0]
    const lastDcac = dSorted[dSorted.length - 1]
    const dcacDelta = firstDcac && lastDcac
      ? pctChange(safe(firstDcac.avg_dc_ac), safe(lastDcac.avg_dc_ac))
      : { label: '—', type: 'neutral' as const }

    return {
      totalUnits: fmt(totalUnits), totalMwdc: fmt(totalMwdc, 1),
      lastUnits: fmt(last.total_units), lastSites: fmt(last.total_sites),
      unitsDelta, sitesDelta,
      lastPower: lastPower ? fmt(lastPower.avg_power_w, 0) + ' W' : '—',
      powerDelta,
      lastDcac: lastDcac ? safe(lastDcac.avg_dc_ac).toFixed(2) : '—',
      dcacDelta,
      firstPeriod: String(first.period), lastPeriod: String(last.period),
    }
  }, [aggGrowth, aggPower, aggDcac])

  // ---- Chart builders ----
  const waferChart = useMemo((): EChartsOption => {
    if (!aggWafer.length || !periods.length) return {}
    // Build stacked 100% bar
    const wafers = WAFER_ORDER.filter((w) => aggWafer.some((r) => r.module_wafer === w))
    const periodTotals: Record<string, number> = {}
    aggWafer.forEach((r) => {
      const p = String(r.period)
      periodTotals[p] = (periodTotals[p] ?? 0) + safe(r.units)
    })
    return {
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = params as { seriesName: string; value: number; color: string; axisValueLabel: string }[]
          if (!Array.isArray(arr) || !arr.length) return ''
          const total = arr.reduce((s, p) => s + (p.value || 0), 0)
          let html = `<b>${arr[0].axisValueLabel}</b><br/>`
          arr.forEach((p) => {
            const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0'
            html += `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${fmt(p.value)} (${pct}%)<br/>`
          })
          return html
        },
      },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: periods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: wafers.map((w) => ({
        name: w, type: 'bar' as const, stack: 'total',
        itemStyle: { color: WAFER_COLORS[w] },
        data: periods.map((p) => {
          const row = aggWafer.find((r) => String(r.period) === p && r.module_wafer === w)
          const units = safe(row?.units)
          const total = periodTotals[p] ?? 1
          return +((units / total) * 100).toFixed(1)
        }),
      })),
    }
  }, [aggWafer, periods])

  const powerChart = useMemo((): EChartsOption => {
    if (!aggPower.length || !periods.length) return {}
    const sorted = [...aggPower].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 60, right: 40 },
      xAxis: { type: 'category', data: sorted.map((r) => String(r.period)) },
      yAxis: [
        { type: 'value', name: 'Power (W)', min: (v: { min: number }) => Math.floor(v.min * 0.95) },
        { type: 'value', name: 'Units', splitLine: { show: false }, position: 'right' as const },
      ],
      series: [
        {
          name: 'Weighted Avg', type: 'line', smooth: true,
          data: sorted.map((r) => +safe(r.avg_power_w).toFixed(1)),
          lineStyle: { width: 3 }, itemStyle: { color: '#2563EB' },
          label: { show: true, position: 'top', formatter: ((p: { value: number }) => `${Math.round(p.value)}W`) as unknown as never },
        },
        {
          name: 'Median', type: 'line', smooth: true,
          data: sorted.map((r) => +safe(r.median_power_w).toFixed(1)),
          lineStyle: { width: 2, type: 'dashed' }, itemStyle: { color: '#059669' },
        },
        {
          name: 'Units', type: 'bar', yAxisIndex: 1,
          data: sorted.map((r) => safe(r.units)),
          itemStyle: { color: 'rgba(37,99,235,0.15)' },
          barMaxWidth: 40,
        },
      ],
    }
  }, [aggPower, periods])

  const dcacChart = useMemo((): EChartsOption => {
    if (!aggDcac.length || !periods.length) return {}
    const sorted = [...aggDcac].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 60, right: 40 },
      xAxis: { type: 'category', data: sorted.map((r) => String(r.period)) },
      yAxis: [
        { type: 'value', name: 'DC/AC Ratio', min: (v: { min: number }) => +(v.min * 0.95).toFixed(2) },
        { type: 'value', name: 'Units', splitLine: { show: false }, position: 'right' as const },
      ],
      series: [
        {
          name: 'Weighted Avg', type: 'line', smooth: true,
          data: sorted.map((r) => +safe(r.avg_dc_ac).toFixed(3)),
          lineStyle: { width: 3 }, itemStyle: { color: '#D97706' },
          label: { show: true, position: 'top', formatter: ((p: { value: number }) => p.value.toFixed(2)) as unknown as never },
        },
        {
          name: 'Median', type: 'line', smooth: true,
          data: sorted.map((r) => +safe(r.median_dc_ac).toFixed(3)),
          lineStyle: { width: 2, type: 'dashed' }, itemStyle: { color: '#C026D3' },
        },
        {
          name: 'Units', type: 'bar', yAxisIndex: 1,
          data: sorted.map((r) => safe(r.units)),
          itemStyle: { color: 'rgba(217,119,6,0.15)' },
          barMaxWidth: 40,
        },
      ],
    }
  }, [aggDcac, periods])

  const productChart = useMemo((): EChartsOption => {
    if (!aggProduct.length || !periods.length) return {}
    // Get top 8 product types overall
    const typeTotal: Record<string, number> = {}
    aggProduct.forEach((r) => { typeTotal[r.product_type] = (typeTotal[r.product_type] ?? 0) + safe(r.units) })
    const topTypes = Object.entries(typeTotal)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t]) => t)
    const periodTotals: Record<string, number> = {}
    aggProduct.forEach((r) => {
      if (topTypes.includes(r.product_type)) {
        const p = String(r.period)
        periodTotals[p] = (periodTotals[p] ?? 0) + safe(r.units)
      }
    })
    return {
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = params as { seriesName: string; value: number; color: string; axisValueLabel: string }[]
          if (!Array.isArray(arr) || !arr.length) return ''
          const total = arr.reduce((s, p) => s + (p.value || 0), 0)
          let html = `<b>${arr[0].axisValueLabel}</b><br/>`
          arr.forEach((p) => {
            const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0'
            html += `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${fmt(p.value)} (${pct}%)<br/>`
          })
          return html
        },
      },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: periods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: topTypes.map((t, i) => ({
        name: t, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: periods.map((p) => {
          const row = aggProduct.find((r) => String(r.period) === p && r.product_type === t)
          const units = safe(row?.units)
          const total = periodTotals[p] ?? 1
          return +((units / total) * 100).toFixed(1)
        }),
      })),
    }
  }, [aggProduct, periods])

  const makeChart = useMemo((): EChartsOption => {
    if (!aggMake.length || !periods.length) return {}
    const makeTotal: Record<string, number> = {}
    aggMake.forEach((r) => { makeTotal[r.pv_module_make] = (makeTotal[r.pv_module_make] ?? 0) + safe(r.units) })
    const topMakes = Object.entries(makeTotal)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([m]) => m)
    const periodTotals: Record<string, number> = {}
    aggMake.forEach((r) => {
      if (topMakes.includes(r.pv_module_make)) {
        const p = String(r.period)
        periodTotals[p] = (periodTotals[p] ?? 0) + safe(r.units)
      }
    })
    return {
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = params as { seriesName: string; value: number; color: string; axisValueLabel: string }[]
          if (!Array.isArray(arr) || !arr.length) return ''
          const total = arr.reduce((s, p) => s + (p.value || 0), 0)
          let html = `<b>${arr[0].axisValueLabel}</b><br/>`
          arr.forEach((p) => {
            const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0'
            html += `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${fmt(p.value)} (${pct}%)<br/>`
          })
          return html
        },
      },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: periods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: topMakes.map((m, i) => ({
        name: m, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: periods.map((p) => {
          const row = aggMake.find((r) => String(r.period) === p && r.pv_module_make === m)
          const units = safe(row?.units)
          const total = periodTotals[p] ?? 1
          return +((units / total) * 100).toFixed(1)
        }),
      })),
    }
  }, [aggMake, periods])

  const bucketChart = useMemo((): EChartsOption => {
    if (!aggBucket.length || !periods.length) return {}
    const allBuckets = Array.from(new Set(aggBucket.map((r) => String(r.power_bucket)))).sort()
    const periodTotals: Record<string, number> = {}
    aggBucket.forEach((r) => {
      const p = String(r.period)
      periodTotals[p] = (periodTotals[p] ?? 0) + safe(r.units)
    })
    return {
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = params as { seriesName: string; value: number; color: string; axisValueLabel: string }[]
          if (!Array.isArray(arr) || !arr.length) return ''
          const total = arr.reduce((s, p) => s + (p.value || 0), 0)
          let html = `<b>${arr[0].axisValueLabel}</b><br/>`
          arr.forEach((p) => {
            const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0'
            html += `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${fmt(p.value)} (${pct}%)<br/>`
          })
          return html
        },
      },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: periods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: allBuckets.map((b, i) => ({
        name: b, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: periods.map((p) => {
          const row = aggBucket.find((r) => String(r.period) === p && String(r.power_bucket) === b)
          const units = safe(row?.units)
          const total = periodTotals[p] ?? 1
          return +((units / total) * 100).toFixed(1)
        }),
      })),
    }
  }, [aggBucket, periods])

  const growthChart = useMemo((): EChartsOption => {
    if (!aggGrowth.length || !periods.length) return {}
    const sorted = [...aggGrowth].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 70, right: 70 },
      xAxis: { type: 'category', data: sorted.map((r) => String(r.period)) },
      yAxis: [
        { type: 'value', name: 'Units', axisLabel: { formatter: (v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v) } },
        { type: 'value', name: 'MWdc', splitLine: { show: false }, position: 'right' as const },
      ],
      series: [
        {
          name: 'Units', type: 'bar',
          data: sorted.map((r) => safe(r.total_units)),
          itemStyle: { color: '#2563EB' }, barMaxWidth: 50,
        },
        {
          name: 'Sites', type: 'bar',
          data: sorted.map((r) => safe(r.total_sites)),
          itemStyle: { color: '#059669' }, barMaxWidth: 50,
        },
        {
          name: 'MWdc', type: 'line', yAxisIndex: 1, smooth: true,
          data: sorted.map((r) => +safe(r.total_mwdc).toFixed(1)),
          lineStyle: { width: 3 }, itemStyle: { color: '#D97706' },
        },
      ],
    }
  }, [aggGrowth, periods])

  // ---- Takeaways (auto-generated insights) ----
  const takeaways = useMemo(() => {
    const insights: { icon: typeof TrendingUp; text: string; type: 'info' | 'success' | 'warning' }[] = []
    if (!periods.length) return insights

    // Wafer transition insight
    if (aggWafer.length > 0) {
      const firstPeriod = periods[0]
      const lastPeriod = periods[periods.length - 1]
      const waferShareAtPeriod = (period: string) => {
        const rows = aggWafer.filter((r) => String(r.period) === period)
        const total = rows.reduce((s, r) => s + safe(r.units), 0)
        const shares: Record<string, number> = {}
        rows.forEach((r) => { shares[r.module_wafer] = total > 0 ? (safe(r.units) / total) * 100 : 0 })
        return shares
      }
      const firstShares = waferShareAtPeriod(firstPeriod)
      const lastShares = waferShareAtPeriod(lastPeriod)
      // Find biggest gainer
      let biggestGainer = '', biggestGain = 0
      Object.keys(lastShares).forEach((w) => {
        const gain = (lastShares[w] ?? 0) - (firstShares[w] ?? 0)
        if (gain > biggestGain) { biggestGainer = w; biggestGain = gain }
      })
      if (biggestGainer && biggestGain > 2) {
        insights.push({
          icon: TrendingUp,
          text: `${biggestGainer} wafer share grew by ${biggestGain.toFixed(1)}pp from ${firstPeriod} to ${lastPeriod}, signaling a shift toward ${biggestGainer === 'G12' || biggestGainer === 'G12R' ? 'larger' : 'established'} wafer formats.`,
          type: 'success',
        })
      }
      // Find biggest loser
      let biggestLoser = '', biggestLoss = 0
      Object.keys(firstShares).forEach((w) => {
        const loss = (firstShares[w] ?? 0) - (lastShares[w] ?? 0)
        if (loss > biggestLoss) { biggestLoser = w; biggestLoss = loss }
      })
      if (biggestLoser && biggestLoss > 2) {
        insights.push({
          icon: TrendingDown,
          text: `${biggestLoser} wafer share declined by ${biggestLoss.toFixed(1)}pp, indicating the market is transitioning away from ${biggestLoser === 'M6' ? 'smaller, legacy' : 'this'} wafer technology.`,
          type: 'warning',
        })
      }
    }

    // Power trend insight
    if (aggPower.length >= 2) {
      const sorted = [...aggPower].sort((a, b) => String(a.period).localeCompare(String(b.period)))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const diff = safe(last.avg_power_w) - safe(first.avg_power_w)
      if (Math.abs(diff) > 5) {
        insights.push({
          icon: diff > 0 ? TrendingUp : TrendingDown,
          text: `Average module power ${diff > 0 ? 'increased' : 'decreased'} by ${Math.abs(diff).toFixed(0)}W (${safe(first.avg_power_w).toFixed(0)}W to ${safe(last.avg_power_w).toFixed(0)}W). ${diff > 0 ? 'Higher-wattage modules are gaining market share, improving system-level economics.' : 'This may reflect regional mix shifts or legacy module paired systems.'}`,
          type: diff > 0 ? 'success' : 'warning',
        })
      }
    }

    // DC/AC ratio insight
    if (aggDcac.length >= 2) {
      const sorted = [...aggDcac].sort((a, b) => String(a.period).localeCompare(String(b.period)))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const diff = safe(last.avg_dc_ac) - safe(first.avg_dc_ac)
      if (Math.abs(diff) > 0.02) {
        insights.push({
          icon: Ratio,
          text: `DC/AC ratio ${diff > 0 ? 'increased' : 'decreased'} from ${safe(first.avg_dc_ac).toFixed(2)} to ${safe(last.avg_dc_ac).toFixed(2)}. ${diff > 0 ? 'Installers are oversizing DC arrays relative to inverter capacity, suggesting confidence in higher energy yields.' : 'DC/AC is tightening, potentially due to higher-AC-wattage inverter adoptions.'}`,
          type: 'info',
        })
      }
    }

    // Product type dominance insight
    if (aggProduct.length > 0) {
      const lastPeriod = periods[periods.length - 1]
      const lastRows = aggProduct.filter((r) => String(r.period) === lastPeriod)
      const total = lastRows.reduce((s, r) => s + safe(r.units), 0)
      const topProduct = lastRows.sort((a, b) => safe(b.units) - safe(a.units))[0]
      if (topProduct && total > 0) {
        const share = (safe(topProduct.units) / total) * 100
        insights.push({
          icon: Package,
          text: `${topProduct.product_type} leads in ${lastPeriod} with ${share.toFixed(1)}% share (${fmt(topProduct.units)} units). ${share > 30 ? 'This dominant position presents upsell and cross-sell opportunities in adjacent segments.' : 'A fragmented market presents opportunities for differentiation.'}`,
          type: 'info',
        })
      }
    }

    // Growth insight
    if (aggGrowth.length >= 2) {
      const sorted = [...aggGrowth].sort((a, b) => String(a.period).localeCompare(String(b.period)))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const growthPct = safe(first.total_units) > 0
        ? ((safe(last.total_units) - safe(first.total_units)) / safe(first.total_units)) * 100
        : 0
      if (Math.abs(growthPct) > 5) {
        insights.push({
          icon: growthPct > 0 ? TrendingUp : TrendingDown,
          text: `Deployment volume ${growthPct > 0 ? 'grew' : 'declined'} by ${Math.abs(growthPct).toFixed(0)}% from ${String(first.period)} to ${String(last.period)} (${fmt(first.total_units)} to ${fmt(last.total_units)} units). ${growthPct < -10 ? 'This may require sales strategy adjustments in the affected regions.' : ''}`,
          type: growthPct > 0 ? 'success' : 'warning',
        })
      }
    }

    return insights
  }, [aggWafer, aggPower, aggDcac, aggProduct, aggGrowth, periods])

  // ---- Loading / empty ----
  if (fleetLoading || !isFleetLoaded) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading fleet data...
      </div>
    )
  }

  const anyLoading = waferLoading || powerLoading || dcacLoading || productLoading || makeLoading || bucketLoading || growthLoading

  const activeChartMap: Record<MetricTab, { chart: EChartsOption; title: string; desc: string }> = {
    wafer: { chart: waferChart, title: 'Wafer Technology Mix', desc: 'Stacked share of wafer types (M6, M10, G12R, G12) over time' },
    power: { chart: powerChart, title: 'Module Power Trend', desc: 'Weighted average and median STC module power (W) over time' },
    dcac: { chart: dcacChart, title: 'DC/AC Ratio Trend', desc: 'Weighted average and median DC/AC sizing ratio over time' },
    product: { chart: productChart, title: 'Microinverter Product Mix', desc: 'Market share of top 8 product types (IQ8HC, IQ8PLUS, etc.)' },
    module_make: { chart: makeChart, title: 'Module Manufacturer Mix', desc: 'Top 10 PV module manufacturers by market share over time' },
    power_bucket: { chart: bucketChart, title: 'Power Bucket Distribution', desc: 'Module power class distribution shifting over time' },
  }

  const active = activeChartMap[activeTab]

  // ---- Individual region chart builder ----
  const buildRegionWaferChart = (region: string): EChartsOption => {
    const rows = (waferData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const rPeriods = Array.from(new Set(rows.map((r) => String(r.period)))).sort()
    const wafers = WAFER_ORDER.filter((w) => rows.some((r) => r.module_wafer === w))
    const periodTotals: Record<string, number> = {}
    rows.forEach((r) => { periodTotals[String(r.period)] = (periodTotals[String(r.period)] ?? 0) + safe(r.units) })
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: rPeriods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: wafers.map((w) => ({
        name: w, type: 'bar' as const, stack: 'total',
        itemStyle: { color: WAFER_COLORS[w] },
        data: rPeriods.map((p) => {
          const row = rows.find((r) => String(r.period) === p && r.module_wafer === w)
          return +((safe(row?.units) / (periodTotals[p] ?? 1)) * 100).toFixed(1)
        }),
      })),
    }
  }

  const buildRegionPowerChart = (region: string): EChartsOption => {
    const rows = (powerData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const sorted = [...rows].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 60, right: 40 },
      xAxis: { type: 'category', data: sorted.map((r) => String(r.period)) },
      yAxis: [
        { type: 'value', name: 'Power (W)', min: (v: { min: number }) => Math.floor(v.min * 0.95) },
        { type: 'value', name: 'Units', splitLine: { show: false }, position: 'right' as const },
      ],
      series: [
        { name: 'Weighted Avg', type: 'line' as const, smooth: true, data: sorted.map((r) => +safe(r.avg_power_w).toFixed(1)), lineStyle: { width: 3 }, itemStyle: { color: '#2563EB' } },
        { name: 'Median', type: 'line' as const, smooth: true, data: sorted.map((r) => +safe(r.median_power_w).toFixed(1)), lineStyle: { width: 2, type: 'dashed' as const }, itemStyle: { color: '#059669' } },
        { name: 'Units', type: 'bar' as const, yAxisIndex: 1, data: sorted.map((r) => safe(r.units)), itemStyle: { color: 'rgba(37,99,235,0.15)' }, barMaxWidth: 40 },
      ],
    }
  }

  const buildRegionProductChart = (region: string): EChartsOption => {
    const rows = (productData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const rPeriods = Array.from(new Set(rows.map((r) => String(r.period)))).sort()
    const typeTotal: Record<string, number> = {}
    rows.forEach((r) => { typeTotal[r.product_type] = (typeTotal[r.product_type] ?? 0) + safe(r.units) })
    const topTypes = Object.entries(typeTotal).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t)
    const periodTotals: Record<string, number> = {}
    rows.forEach((r) => { if (topTypes.includes(r.product_type)) { periodTotals[String(r.period)] = (periodTotals[String(r.period)] ?? 0) + safe(r.units) } })
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: rPeriods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: topTypes.map((t, i) => ({
        name: t, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: rPeriods.map((p) => {
          const row = rows.find((r) => String(r.period) === p && r.product_type === t)
          return +((safe(row?.units) / (periodTotals[p] ?? 1)) * 100).toFixed(1)
        }),
      })),
    }
  }

  const buildRegionDcacChart = (region: string): EChartsOption => {
    const rows = (dcacData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const sorted = [...rows].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 60, right: 40 },
      xAxis: { type: 'category', data: sorted.map((r) => String(r.period)) },
      yAxis: [
        { type: 'value', name: 'DC/AC Ratio', min: (v: { min: number }) => +(v.min * 0.95).toFixed(2) },
        { type: 'value', name: 'Units', splitLine: { show: false }, position: 'right' as const },
      ],
      series: [
        { name: 'Weighted Avg', type: 'line' as const, smooth: true, data: sorted.map((r) => +safe(r.avg_dc_ac).toFixed(3)), lineStyle: { width: 3 }, itemStyle: { color: '#D97706' } },
        { name: 'Median', type: 'line' as const, smooth: true, data: sorted.map((r) => +safe(r.median_dc_ac).toFixed(3)), lineStyle: { width: 2, type: 'dashed' as const }, itemStyle: { color: '#C026D3' } },
        { name: 'Units', type: 'bar' as const, yAxisIndex: 1, data: sorted.map((r) => safe(r.units)), itemStyle: { color: 'rgba(217,119,6,0.15)' }, barMaxWidth: 40 },
      ],
    }
  }

  const buildRegionMakeChart = (region: string): EChartsOption => {
    const rows = (makeData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const rPeriods = Array.from(new Set(rows.map((r) => String(r.period)))).sort()
    const makeTotal: Record<string, number> = {}
    rows.forEach((r) => { makeTotal[r.pv_module_make] = (makeTotal[r.pv_module_make] ?? 0) + safe(r.units) })
    const topMakes = Object.entries(makeTotal).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m]) => m)
    const periodTotals: Record<string, number> = {}
    rows.forEach((r) => { if (topMakes.includes(r.pv_module_make)) { periodTotals[String(r.period)] = (periodTotals[String(r.period)] ?? 0) + safe(r.units) } })
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: rPeriods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: topMakes.map((m, i) => ({
        name: m, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: rPeriods.map((p) => {
          const row = rows.find((r) => String(r.period) === p && r.pv_module_make === m)
          return +((safe(row?.units) / (periodTotals[p] ?? 1)) * 100).toFixed(1)
        }),
      })),
    }
  }

  const buildRegionBucketChart = (region: string): EChartsOption => {
    const rows = (bucketData ?? []).filter((r) => r.tss_region === region)
    if (!rows.length) return {}
    const rPeriods = Array.from(new Set(rows.map((r) => String(r.period)))).sort()
    const allBuckets = Array.from(new Set(rows.map((r) => String(r.power_bucket)))).sort()
    const periodTotals: Record<string, number> = {}
    rows.forEach((r) => { periodTotals[String(r.period)] = (periodTotals[String(r.period)] ?? 0) + safe(r.units) })
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, type: 'scroll' },
      grid: { top: 40, bottom: 30, left: 50, right: 20 },
      xAxis: { type: 'category', data: rPeriods },
      yAxis: { type: 'value', name: '%', max: 100, axisLabel: { formatter: '{value}%' } },
      series: allBuckets.map((b, i) => ({
        name: b, type: 'bar' as const, stack: 'total',
        itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
        data: rPeriods.map((p) => {
          const row = rows.find((r) => String(r.period) === p && String(r.power_bucket) === b)
          return +((safe(row?.units) / (periodTotals[p] ?? 1)) * 100).toFixed(1)
        }),
      })),
    }
  }

  const buildRegionChart = (region: string): EChartsOption => {
    switch (activeTab) {
      case 'wafer': return buildRegionWaferChart(region)
      case 'power': return buildRegionPowerChart(region)
      case 'dcac': return buildRegionDcacChart(region)
      case 'product': return buildRegionProductChart(region)
      case 'module_make': return buildRegionMakeChart(region)
      case 'power_bucket': return buildRegionBucketChart(region)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <ArrowRight className="h-7 w-7 text-primary" />
          Transition Analytics
        </h1>
        <p className="text-sm text-muted-foreground">
          Track how wafer technology, module power, DC/AC ratios, and product mix evolve over time across regions
          {allQuarters ? ` (${allQuarters.length} quarters available)` : ''}
        </p>
      </div>

      {/* Filters bar */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-5 pb-4">
          <MultiSelectDropdown
            label="Region"
            options={regionOptions}
            selected={selectedTssRegions}
            onChange={(v) => { setSelectedTssRegions(v); setSelectedTssCountries([]) }}
            formatLabel={tssRegionLabel}
          />
          <MultiSelectDropdown
            label="Country"
            options={countryOptions}
            selected={selectedTssCountries}
            onChange={setSelectedTssCountries}
            disabled={countryOptions.length === 0}
          />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Resolution:</span>
            <Select value={resolution} onValueChange={(v) => setResolution(v as TimeResolution)}>
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="half-yearly">Half-Yearly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* KPI Row */}
      {kpis && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <KPICard icon={Zap} label={`Units (${kpis.lastPeriod})`} value={kpis.lastUnits}
            delta={`${kpis.unitsDelta.label} vs ${kpis.firstPeriod}`} deltaType={kpis.unitsDelta.type} />
          <KPICard icon={BarChart3} label="Avg Module Power" value={kpis.lastPower}
            delta={`${kpis.powerDelta.label} trend`} deltaType={kpis.powerDelta.type} />
          <KPICard icon={Ratio} label="Avg DC/AC Ratio" value={kpis.lastDcac}
            delta={`${kpis.dcacDelta.label} trend`} deltaType={kpis.dcacDelta.type} />
          <KPICard icon={Layers} label={`Sites (${kpis.lastPeriod})`} value={kpis.lastSites}
            delta={`${kpis.sitesDelta.label} vs ${kpis.firstPeriod}`} deltaType={kpis.sitesDelta.type} />
        </div>
      )}

      {/* Growth Overview Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" /> Deployment Volume
          </CardTitle>
          <CardDescription>Units, sites, and MWdc deployed per {resolution === 'quarterly' ? 'quarter' : resolution === 'half-yearly' ? 'half' : 'year'}</CardDescription>
        </CardHeader>
        <CardContent>
          {anyLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : (
            <BarChart option={growthChart} height={280} />
          )}
        </CardContent>
      </Card>

      {/* Metric Tabs + Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Parameter Transition</CardTitle>
          <CardDescription>Select a parameter to see how it evolves over time</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as MetricTab)}>
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="wafer" className="gap-1 text-xs">
                <Layers className="h-3.5 w-3.5" /> Wafer Tech
              </TabsTrigger>
              <TabsTrigger value="power" className="gap-1 text-xs">
                <Zap className="h-3.5 w-3.5" /> Module Power
              </TabsTrigger>
              <TabsTrigger value="dcac" className="gap-1 text-xs">
                <Ratio className="h-3.5 w-3.5" /> DC/AC Ratio
              </TabsTrigger>
              <TabsTrigger value="product" className="gap-1 text-xs">
                <Package className="h-3.5 w-3.5" /> Product Mix
              </TabsTrigger>
              <TabsTrigger value="module_make" className="gap-1 text-xs">
                <Factory className="h-3.5 w-3.5" /> Module Make
              </TabsTrigger>
              <TabsTrigger value="power_bucket" className="gap-1 text-xs">
                <BarChart3 className="h-3.5 w-3.5" /> Power Bucket
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">{active.title}</h3>
              <p className="text-xs text-muted-foreground">{active.desc}</p>
            </div>
            {multiSelected && (
              <div className="flex items-center gap-1 rounded-lg border p-0.5">
                <Button
                  variant={viewMode === 'combined' ? 'default' : 'ghost'}
                  size="sm"
                  className="gap-1.5 h-7 text-xs px-2.5"
                  onClick={() => setViewMode('combined')}
                >
                  <Combine className="h-3.5 w-3.5" /> Combined
                </Button>
                <Button
                  variant={viewMode === 'individual' ? 'default' : 'ghost'}
                  size="sm"
                  className="gap-1.5 h-7 text-xs px-2.5"
                  onClick={() => setViewMode('individual')}
                >
                  <LayoutGrid className="h-3.5 w-3.5" /> Individual
                </Button>
              </div>
            )}
          </div>

          {anyLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : viewMode === 'individual' && multiSelected ? (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {dataRegions.map((region) => (
                <Card key={region} className="border-dashed">
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-sm">{tssRegionLabel(region)}</CardTitle>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <BarChart option={buildRegionChart(region)} height={300} />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <BarChart option={active.chart} height={380} />
          )}
        </CardContent>
      </Card>

      {/* Takeaways */}
      {takeaways.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-4 w-4 text-amber-500" /> Key Takeaways
            </CardTitle>
            <CardDescription>
              Auto-generated insights based on the selected filters and time range
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {takeaways.map((t, i) => {
                const Icon = t.icon
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 rounded-lg border p-3 ${
                      t.type === 'success' ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30' :
                      t.type === 'warning' ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30' :
                      'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30'
                    }`}
                  >
                    <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                      t.type === 'success' ? 'text-green-600' :
                      t.type === 'warning' ? 'text-amber-600' :
                      'text-blue-600'
                    }`} />
                    <p className="text-sm">{t.text}</p>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contextual badges showing active filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Filters:</span>
        {selectedTssRegions.length === 0 && selectedTssCountries.length === 0 && (
          <Badge variant="outline">All Regions</Badge>
        )}
        {selectedTssRegions.map((r) => (
          <Badge key={r} variant="secondary">{tssRegionLabel(r)}</Badge>
        ))}
        {selectedTssCountries.map((c) => (
          <Badge key={c} variant="secondary">{c}</Badge>
        ))}
        <Badge variant="outline">{resolution === 'quarterly' ? 'Quarterly' : resolution === 'half-yearly' ? 'Half-Yearly' : 'Yearly'}</Badge>
        {periods.length > 0 && (
          <Badge variant="outline">{periods[0]} to {periods[periods.length - 1]}</Badge>
        )}
      </div>
    </div>
  )
}
