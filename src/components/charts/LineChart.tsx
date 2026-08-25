import { useRef, useEffect, useState } from 'react'
import * as echarts from 'echarts/core'
import { LineChart as ELineChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  MarkLineComponent,
  MarkAreaComponent,
  TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'

echarts.use([
  ELineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  MarkLineComponent,
  MarkAreaComponent,
  TitleComponent,
  CanvasRenderer,
])

function useIsDark() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

interface LineChartProps {
  option: EChartsOption
  height?: number | string
  className?: string
  notMerge?: boolean
}

export default function LineChart({
  option,
  height = 400,
  className,
  notMerge = true,
}: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const isDark = useIsDark()

  // Guard: don't render echarts with empty or undefined option
  const hasOption = option && typeof option === 'object' && Object.keys(option).length > 0

  // Reinit chart on theme change
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.dispose()
      chartRef.current = null
    }
  }, [isDark])

  useEffect(() => {
    if (!containerRef.current || !hasOption) return

    try {
      if (!chartRef.current) {
        chartRef.current = echarts.init(
          containerRef.current,
          isDark ? 'dark' : undefined,
          { renderer: 'canvas' }
        )
      }
      chartRef.current.setOption(option, { notMerge, lazyUpdate: true })
    } catch (err) {
      console.error('[LineChart setOption error]', err)
    }
  }, [option, hasOption, notMerge, isDark])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  if (!hasOption) {
    return (
      <div
        style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        className={className}
      >
        <span style={{ color: '#9ca3af', fontSize: 13 }}>No chart data</span>
      </div>
    )
  }

  return <div ref={containerRef} style={{ height, width: '100%' }} className={className} />
}
