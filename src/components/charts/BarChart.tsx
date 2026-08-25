import { useRef, useEffect, useState } from 'react'
import * as echarts from 'echarts/core'
import { BarChart as EBarChart } from 'echarts/charts'
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'

echarts.use([
  EBarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
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

interface BarChartProps {
  option: EChartsOption
  height?: number | string
  className?: string
  onEvents?: Record<string, (params: Record<string, unknown>) => void>
}

export default function BarChart({
  option,
  height = 400,
  className,
  onEvents,
}: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const isDark = useIsDark()

  const hasOption = option && typeof option === 'object' && Object.keys(option).length > 0

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
      chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })

      // Bind events
      if (onEvents && chartRef.current) {
        const chart = chartRef.current
        Object.entries(onEvents).forEach(([eventName, handler]) => {
          chart.on(eventName, (params: unknown) => handler(params as Record<string, unknown>))
        })
      }
    } catch (err) {
      console.error('[BarChart setOption error]', err)
    }
  }, [option, hasOption, onEvents])

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
