import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import LineChart from '@/components/charts/LineChart'
import type { ModuleSpec } from '@/lib/moduleSpecs'
import {
  generateVICurve,
  generateVICurveAtTemp,
  generateClippedCurrentCurve,
  DEFAULT_MODULE_SPEC,
} from '@/lib/moduleSpecs'

const IRR_LEVELS = [
  { wm2: 1000, label: '1000 W/m²', color: '#1d4ed8', width: 2.5 },
  { wm2:  800, label: '800 W/m²',  color: '#0d9488', width: 2 },
  { wm2:  600, label: '600 W/m²',  color: '#d97706', width: 2 },
  { wm2:  400, label: '400 W/m²',  color: '#7c3aed', width: 1.5 },
] as const

interface VICurveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clippedCurrentA: number
  avgVoltage: number | null
  moduleSpec: ModuleSpec | null
  skuLabel: string
  /** Average cell/inverter temperature (°C) during clipping. When provided, an additional temp-adjusted STC curve is drawn. */
  cellTempC?: number | null
}

export default function VICurveDialog({
  open, onOpenChange, clippedCurrentA, avgVoltage, moduleSpec, skuLabel, cellTempC,
}: VICurveDialogProps) {
  const spec = moduleSpec ?? DEFAULT_MODULE_SPEC
  const hasTemp = cellTempC != null && Number.isFinite(cellTempC) && Math.abs(cellTempC! - 25) > 1

  const chartOption = useMemo((): EChartsOption => {
    // V-I curves at multiple irradiance levels (STC = 25°C)
    const viCurves = IRR_LEVELS.map((lvl) => ({
      ...lvl,
      data: generateVICurve(spec, lvl.wm2),
    }))

    // Temperature-adjusted curve at 1000 W/m² (if temp available)
    const tempCurve = hasTemp
      ? generateVICurveAtTemp(spec, 1000, cellTempC!, 100)
      : null

    // Clipping-current → irradiance/voltage curve (right Y-axis)
    const clippedCurve = generateClippedCurrentCurve(spec, clippedCurrentA)

    // Check if clipping current is within the STC curve range
    const clipWithinRange = clippedCurrentA <= spec.isc && clippedCurrentA > 0

    // Find intersection point of clipping current with the STC V-I curve
    let clipIntersectV: number | null = null
    if (clipWithinRange) {
      const stcData = viCurves[0].data // 1000 W/m² curve
      for (let i = 0; i < stcData.voltage.length - 1; i++) {
        const i0 = stcData.current[i]
        const i1 = stcData.current[i + 1]
        if ((i0 >= clippedCurrentA && i1 <= clippedCurrentA) || (i0 <= clippedCurrentA && i1 >= clippedCurrentA)) {
          // Linear interpolation
          const t = (clippedCurrentA - i0) / (i1 - i0)
          clipIntersectV = stcData.voltage[i] + t * (stcData.voltage[i + 1] - stcData.voltage[i])
          break
        }
      }
    }

    // Pmax point on STC curve (Vmp, Imp)
    const pmaxPoint = [[spec.vmp, spec.imp]]

    // Operating point
    const opPoint = avgVoltage != null
      ? [[avgVoltage, clippedCurrentA]]
      : []

    const vMax = Math.ceil(spec.voc * 1.08)

    // V-I series for each irradiance
    const viSeries = viCurves.map((c) => ({
      name: c.label,
      type: 'line' as const,
      data: c.data.voltage.map((v, i) => [v, c.data.current[i]]),
      smooth: true,
      symbol: 'none',
      lineStyle: { color: c.color, width: c.width },
      itemStyle: { color: c.color },
    }))

    // Temperature-adjusted STC curve series (dashed orange)
    const tempSeries = tempCurve
      ? [{
          name: `1000 W/m² @ ${cellTempC!.toFixed(0)}°C`,
          type: 'line' as const,
          data: tempCurve.voltage.map((v, i) => [v, tempCurve.current[i]]),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#ea580c', width: 2.5, type: 'dashed' as const },
          itemStyle: { color: '#ea580c' },
        }]
      : []

    return {
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#d1d5db',
        textStyle: { fontSize: 11, color: '#374151' },
        formatter: (params: unknown) => {
          if (!Array.isArray(params)) return ''
          const items = params as Array<{ seriesName: string; marker: string; data: number[] }>
          const valid = items.filter((p) => p.data && p.data.length >= 2)
          if (valid.length === 0) return ''
          const v = valid[0].data[0]
          const lines = valid.map((p) => {
            const isIrr = p.seriesName.includes('Irradiance')
            const unit = isIrr ? 'W/m²' : 'A'
            const dec = isIrr ? 0 : 3
            return `${p.marker} ${p.seriesName}: <b>${p.data[1].toFixed(dec)} ${unit}</b>`
          })
          return `<b>V = ${v.toFixed(1)} V</b><br/>${lines.join('<br/>')}`
        },
      },
      legend: {
        type: 'scroll',
        top: 0,
        left: 'center',
        width: '85%',
        textStyle: { fontSize: 10 },
        itemWidth: 14,
        itemGap: 10,
        pageIconSize: 10,
      },
      grid: { top: 45, right: 85, bottom: 50, left: 60 },
      xAxis: {
        type: 'value',
        name: 'Voltage (V)',
        nameLocation: 'middle',
        nameGap: 30,
        nameTextStyle: { fontSize: 11, fontWeight: 'bold' },
        max: vMax,
        min: 0,
        splitLine: { lineStyle: { type: 'dashed', color: '#e5e7eb' } },
        axisLabel: { fontSize: 10, rotate: 0, interval: 0, formatter: (v: number) => `${Math.round(v)}` },
        splitNumber: 8,
      },
      yAxis: [
        {
          type: 'value',
          name: 'Current (A)',
          nameTextStyle: { fontSize: 11, fontWeight: 'bold' },
          min: 0,
          splitLine: { lineStyle: { type: 'dashed', color: '#e5e7eb' } },
          axisLabel: { fontSize: 10 },
        },
        {
          type: 'value',
          name: 'Irradiance\n(W/m²)',
          position: 'right',
          nameTextStyle: { fontSize: 10, color: '#dc2626', lineHeight: 14 },
          min: 0,
          max: 1500,
          splitLine: { show: false },
          axisLabel: { fontSize: 9, color: '#dc2626' },
        },
      ],
      series: [
        ...viSeries,
        ...tempSeries,

        // Clipping current horizontal line
        {
          name: `Clip ${clippedCurrentA.toFixed(1)} A`,
          type: 'line',
          data: [[0, clippedCurrentA], [vMax, clippedCurrentA]],
          symbol: 'none',
          lineStyle: { color: '#dc2626', width: 2, type: 'dashed' },
          itemStyle: { color: '#dc2626' },
        },

        // Irradiance needed to produce clipping current at each voltage (right Y-axis)
        {
          name: `Irr. @ clip`,
          type: 'line',
          yAxisIndex: 1,
          data: clippedCurve.voltage.map((v, i) => [v, clippedCurve.irradiance[i]]),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#dc2626', width: 2 },
          itemStyle: { color: '#dc2626' },
          areaStyle: { color: 'rgba(220,38,38,0.05)' },
        },

        // Pmax marker (Vmp, Imp) on STC curve
        {
          name: `Pmax ${spec.pmax}W`,
          type: 'scatter',
          data: pmaxPoint,
          symbol: 'diamond',
          symbolSize: 14,
          itemStyle: { color: '#16a34a', borderColor: '#fff', borderWidth: 2 },
          z: 10,
          label: {
            show: true,
            position: 'right',
            formatter: `Imp=${spec.imp.toFixed(2)}A`,
            fontSize: 9,
            color: '#16a34a',
            fontWeight: 'bold',
          },
        },

        // Isc annotation at V=0 on STC curve
        {
          name: `Isc ${spec.isc.toFixed(2)}A`,
          type: 'scatter',
          data: [[0, spec.isc]],
          symbol: 'triangle',
          symbolSize: 10,
          itemStyle: { color: '#1d4ed8', borderColor: '#fff', borderWidth: 1.5 },
          z: 10,
          label: {
            show: true,
            position: 'right',
            formatter: `Isc=${spec.isc.toFixed(2)}A`,
            fontSize: 9,
            color: '#1d4ed8',
            fontWeight: 'bold',
          },
        },

        // Clip–STC intersection point
        ...(clipIntersectV != null
          ? [{
              name: `Clip intersect`,
              type: 'scatter' as const,
              data: [[clipIntersectV, clippedCurrentA]],
              symbol: 'circle',
              symbolSize: 10,
              itemStyle: { color: '#dc2626', borderColor: '#fff', borderWidth: 2 },
              z: 10,
            }]
          : []),

        // Operating point
        ...(opPoint.length > 0
          ? [{
              name: `Op. Pt ${avgVoltage!.toFixed(1)}V`,
              type: 'scatter' as const,
              data: opPoint,
              symbol: 'circle',
              symbolSize: 12,
              itemStyle: { color: '#f97316', borderColor: '#fff', borderWidth: 2 },
              z: 10,
            }]
          : []),
      ],
    }
  }, [spec, clippedCurrentA, avgVoltage, hasTemp, cellTempC])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>V-I Curve — {skuLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Spec summary */}
          <div className={`grid grid-cols-3 gap-2 text-xs ${hasTemp ? 'sm:grid-cols-7' : 'sm:grid-cols-6'}`}>
            {[
              { label: 'Module', value: spec.name },
              { label: 'Voc', value: `${spec.voc} V` },
              { label: 'Isc', value: `${spec.isc} A` },
              { label: 'Vmp', value: `${spec.vmp.toFixed(1)} V` },
              { label: 'Imp', value: `${spec.imp.toFixed(2)} A` },
              { label: 'Pmax', value: `${spec.pmax} W` },
              ...(hasTemp ? [{ label: 'Cell Temp', value: `${cellTempC!.toFixed(1)} °C` }] : []),
            ].map((item) => (
              <div key={item.label} className={`rounded border px-2 py-1.5 text-center ${
                item.label === 'Cell Temp' ? 'bg-orange-50 border-orange-200 dark:bg-orange-950 dark:border-orange-800' : 'bg-muted/40'
              }`}>
                <p className="text-[9px] uppercase text-muted-foreground">{item.label}</p>
                <p className="font-semibold">{item.value}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs dark:border-red-900 dark:bg-red-950">
            <span className="font-medium text-red-700 dark:text-red-400">Clipping @</span>
            <span className="font-bold text-red-700 dark:text-red-400">{clippedCurrentA.toFixed(2)} A</span>
            <span className="text-red-600/80 dark:text-red-400/80">
              ({((clippedCurrentA / spec.isc) * 100).toFixed(0)}% of Isc,{' '}
              {((clippedCurrentA / spec.imp) * 100).toFixed(0)}% of Imp)
            </span>
          </div>

          {/* Chart */}
          <LineChart option={chartOption} height={450} />

          <div className="text-[10px] text-muted-foreground leading-relaxed">
            <strong className="text-blue-600">Blue triangle</strong> = Isc ({spec.isc} A at V=0).{' '}
            <strong className="text-green-600">Green diamond</strong> = Pmax = Vmp &times; Imp ({spec.vmp.toFixed(1)}V &times; {spec.imp.toFixed(2)}A = {spec.pmax}W).{' '}
            <strong className="text-red-600">Red dashed</strong> = Clipping current.{' '}
            <strong className="text-red-600">Right axis</strong> = Irradiance for clipping current at each voltage.{' '}
            {hasTemp && (
              <><strong className="text-orange-600">Orange dashed</strong> = 1000 W/m² curve at {cellTempC!.toFixed(0)}°C cell temperature (α<sub>Isc</sub>=+0.05%/°C, β<sub>Voc</sub>=−0.30%/°C).{' '}</>
            )}
            Note: Isc is the max current at V=0, while Imp &lt; Isc is the current at maximum power point.
            {hasTemp && <> Solid curves are at STC (25°C).</>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
