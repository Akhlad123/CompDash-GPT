import { useState, useMemo } from 'react'
import { Loader2, MapPin, Sun, Layers, Zap, Link as LinkIcon, ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useSiteFleetInfo } from '@/hooks/useSiteFleetInfo'

function safeNum(n: unknown): number | null {
  if (n === null || n === undefined) return null
  const v = Number(n)
  return Number.isFinite(v) ? v : null
}

function fmtNum(n: unknown, decimals = 2): string {
  const v = safeNum(n)
  return v !== null ? v.toFixed(decimals) : '—'
}

interface SiteContextPanelProps {
  siteId: string | null | undefined
}

/**
 * Surfaces Fleet metadata (region, module wafer, STC rating, irradiance,
 * etc.) for a given site_id on Telemetry pages. site_id is the join key
 * between the `fleet` and `telemetry` DuckDB tables (see
 * CompDashGPT.windsurfrules.txt rule 13). When a site has multiple
 * microinverter types (multiple rows in fleet), all are shown in "More
 * Fleet Info". Lazily loads the bundled Fleet Parquet on mount so
 * Telemetry-only sessions aren't penalized until a SiteContextPanel is
 * actually rendered.
 */
export default function SiteContextPanel({ siteId }: SiteContextPanelProps) {
  const { isLoading: fleetLoading, error: fleetError } = useEnsureFleetData()
  const { info, allRows, isLoading, notFound } = useSiteFleetInfo(siteId)
  const [showMore, setShowMore] = useState(false)
  const [showMonthly, setShowMonthly] = useState(false)

  // Irradiance / irradiation derived values (safe even when info is null)
  const irrDay = info ? safeNum(info.irr_ann_kwh_m2_month) : null
  const irrWm2 = irrDay !== null ? irrDay * (1000 / 24) : null
  const irrKwhMonth = irrDay !== null ? irrDay * 30.44 : null
  const irrKwhYear = irrDay !== null ? irrDay * 365.25 : null
  const latitude = info ? safeNum(info.latitude) : null

  const monthlyIrradiation = useMemo(() => {
    if (irrDay === null) return null
    const NH_WEIGHTS = [0.55, 0.65, 0.85, 1.05, 1.25, 1.35, 1.35, 1.20, 1.00, 0.80, 0.60, 0.50]
    const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    let weights = NH_WEIGHTS
    if (latitude !== null && latitude < 0) {
      weights = [...NH_WEIGHTS.slice(6), ...NH_WEIGHTS.slice(0, 6)]
    }
    const wSum = weights.reduce((s, w, i) => s + w * MONTH_DAYS[i], 0)
    const totalDays = MONTH_DAYS.reduce((s, d) => s + d, 0)
    const factor = totalDays / wSum
    return MONTH_NAMES.map((name, i) => ({
      name,
      kwhMonth: Math.round(irrDay * weights[i] * factor * MONTH_DAYS[i] * 10) / 10,
      wm2: Math.round(irrDay * weights[i] * factor * (1000 / 24) * 10) / 10,
    }))
  }, [irrDay, latitude])

  if (!siteId) return null

  if (fleetError) {
    return null // Fleet data unavailable — fail silently, telemetry view still works standalone.
  }

  if (fleetLoading || isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading Fleet context…
      </div>
    )
  }

  if (notFound || !info) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <LinkIcon className="h-3.5 w-3.5" /> No Fleet record found for site {siteId}.
      </div>
    )
  }

  const stc = safeNum(info.stc_rating2)
  const units = safeNum(info.unit_count)

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <LinkIcon className="h-3.5 w-3.5" /> Fleet Context
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {(info.city || info.state || info.country) && (
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            {[info.city, info.state, info.country].filter(Boolean).join(', ')}
          </span>
        )}
        {info.region_bundle && (
          <Badge variant="secondary">{info.region_bundle}</Badge>
        )}
        {info.module_wafer && (
          <span className="inline-flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            {info.module_wafer}
            {info.pv_module_make ? ` (${info.pv_module_make})` : ''}
          </span>
        )}
        {stc !== null && (
          <span className="inline-flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            {stc.toLocaleString()} W STC
          </span>
        )}
        {units !== null && (
          <span className="text-muted-foreground">{units.toLocaleString()} units</span>
        )}
        {irrWm2 !== null && (
          <span className="inline-flex items-center gap-1.5">
            <Sun className="h-3.5 w-3.5 text-amber-500" />
            {irrWm2.toFixed(1)} W/m²
          </span>
        )}
        {irrKwhYear !== null && (
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
            <Sun className="h-3.5 w-3.5" />
            {irrKwhYear.toFixed(0)} kWh/m²/yr
          </span>
        )}
        {irrKwhMonth !== null && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm text-amber-700 underline-offset-2 hover:bg-amber-100 hover:underline dark:text-amber-400 dark:hover:bg-amber-900/30"
            onClick={() => setShowMonthly((v) => !v)}
            title="Click to see monthly irradiation breakdown"
          >
            <Sun className="h-3 w-3" />
            {irrKwhMonth.toFixed(1)} kWh/m²/mo
            {showMonthly ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
        {info.quarter_first_interval && (
          <span className="text-muted-foreground">Installed {info.quarter_first_interval}</span>
        )}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto h-6 px-1.5 text-xs text-muted-foreground"
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? <ChevronDown className="mr-1 h-3 w-3" /> : <ChevronRight className="mr-1 h-3 w-3" />}
          More Fleet Info
        </Button>
      </div>

      {showMonthly && monthlyIrradiation && (
        <div className="mt-3 border-t pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Estimated Monthly Irradiation (based on annual avg {irrDay?.toFixed(2)} kWh/m²/day)
          </p>
          <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
            {monthlyIrradiation.map((m) => (
              <div key={m.name} className="rounded border bg-muted/40 px-1.5 py-1 text-center">
                <p className="text-[9px] font-medium text-muted-foreground">{m.name}</p>
                <p className="text-xs font-bold tabular-nums">{m.kwhMonth}</p>
                <p className="text-[9px] text-muted-foreground tabular-nums">{m.wm2} W/m²</p>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3 border-t pt-2">
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
              Annual Total: {monthlyIrradiation.reduce((s, m) => s + m.kwhMonth, 0).toFixed(0)} kWh/m²/yr
            </span>
            <span className="text-[9px] text-muted-foreground">
              (avg {irrDay?.toFixed(2)} kWh/m²/day)
            </span>
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground/70">
            kWh/m²/month per month. W/m² is average irradiance. Values are estimated from annual average using seasonal profile.
          </p>
        </div>
      )}

      {showMore && (
        <div className="mt-3 border-t pt-3">
          {allRows.length > 1 && (
            <p className="mb-2 text-xs text-muted-foreground">
              This site has <strong>{allRows.length} microinverter configurations</strong>:
            </p>
          )}
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap text-xs">Product Type</TableHead>
                  <TableHead className="whitespace-nowrap text-xs">DC/AC Ratio</TableHead>
                  <TableHead className="whitespace-nowrap text-xs">PV Module Model</TableHead>
                  <TableHead className="whitespace-nowrap text-xs">Voc (V)</TableHead>
                  <TableHead className="whitespace-nowrap text-xs">Isc (A)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allRows.map((row, i) => (
                  <TableRow key={`${row.product_type}-${i}`}>
                    <TableCell className="text-xs font-medium">{row.product_type ?? '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtNum(row.dc_ac_ratio)}</TableCell>
                    <TableCell className="text-xs">{row.pv_module_model ?? '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtNum(row.voc, 1)}</TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtNum(row.isc)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}
