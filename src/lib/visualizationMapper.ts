// Visualization mapper: given an AnalysisRequest + tool result rows,
// recommends the best ECharts chart type and generates the option object.
// The LLM can suggest a chart type via request.visualization; this module
// validates and falls back to heuristics if the suggestion is inappropriate.

import type { AnalysisRequest } from './intentRouter'
import type { ToolResult } from './analyticsTools'

export type ChartType = 'bar' | 'line' | 'scatter' | 'histogram' | 'table' | 'kpi' | 'heatmap' | 'box'

export interface VisualizationRecommendation {
  chartType: ChartType
  /** Reason for the recommendation (for debug/observability) */
  reason: string
  /** ECharts option object — null for 'table' and 'kpi' types (rendered by existing table UI) */
  echartsOption: Record<string, unknown> | null
  /** For KPI type: the primary numeric value */
  kpiValue?: number | string
  kpiLabel?: string
  kpiUnit?: string
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

const TIME_BUCKET_KEYS = ['bucket', 'hour', 'date', 'day', 'week', 'month', 'period', 'timestamp']
const CATEGORY_KEYS = [
  'tss_region', 'region_bundle', 'country', 'product_type', 'module_wafer',
  'power_bucket', 'quarter_first_interval', 'sku_name', 'site_id', 'serial_number',
  'status', 'clipping_type',
]
const NUMERIC_KEYS = [
  'result', 'total_units', 'unit_count', 'site_count', 'total_mwdc', 'total_mwac',
  'avg_dc_ac_ratio', 'avg_stc_rating_w', 'dc_ac_ratio', 'total_energy_kwh', 'total_energy_wh',
  'energy_kwh', 'energy_wh', 'value', 'avg_value', 'avg_utilization_pct', 'z_score',
  'duration_hours', 'pct_of_rated', 'avg_temperature_c',
]

function sniffColumns(rows: Record<string, unknown>[]): { categories: string[]; numerics: string[]; timeSeries: string | null } {
  if (rows.length === 0) return { categories: [], numerics: [], timeSeries: null }
  const keys = Object.keys(rows[0])
  const timeSeries = keys.find((k) => TIME_BUCKET_KEYS.includes(k)) ?? null
  const categories = keys.filter((k) => CATEGORY_KEYS.includes(k))
  const numerics = keys.filter((k) => NUMERIC_KEYS.includes(k) && typeof rows[0][k] === 'number')
  return { categories, numerics, timeSeries }
}

function inferChartType(
  rows: Record<string, unknown>[],
  requested: ChartType | undefined,
  intent: string
): { type: ChartType; reason: string } {
  if (rows.length === 0) return { type: 'table', reason: 'No data to visualize' }
  if (rows.length === 1) return { type: 'kpi', reason: 'Single row — show as KPI card' }

  const { categories, numerics, timeSeries } = sniffColumns(rows)

  // LLM suggestion is accepted if it makes structural sense
  if (requested === 'line' && timeSeries) return { type: 'line', reason: 'LLM suggested line, time column found' }
  if (requested === 'bar' && categories.length > 0) return { type: 'bar', reason: 'LLM suggested bar, category column found' }
  if (requested === 'kpi' && rows.length <= 3) return { type: 'kpi', reason: 'LLM suggested KPI' }
  if (requested === 'table') return { type: 'table', reason: 'LLM requested table' }
  if (requested === 'scatter' && numerics.length >= 2) return { type: 'scatter', reason: 'LLM suggested scatter, enough numeric cols' }
  if (requested === 'heatmap') return { type: 'heatmap', reason: 'LLM suggested heatmap' }

  // Heuristic fallback
  if (timeSeries && numerics.length > 0) return { type: 'line', reason: 'Time column found → line chart' }
  if (intent === 'anomaly_detect') return { type: 'bar', reason: 'Anomaly intent → bar chart (z-score by inverter)' }
  if (intent === 'clipping') return { type: 'bar', reason: 'Clipping intent → bar chart (duration by inverter)' }
  if (intent === 'inverter_utilization') return { type: 'bar', reason: 'Utilization intent → bar chart' }
  if (categories.length > 0 && numerics.length > 0) return { type: 'bar', reason: 'Category + numeric → bar chart' }
  if (numerics.length >= 2) return { type: 'scatter', reason: 'Multiple numerics → scatter' }
  return { type: 'table', reason: 'No clear chart structure → table' }
}

// ─── ECharts option builders ──────────────────────────────────────────────────

function buildBarOption(rows: Record<string, unknown>[], categories: string[], numerics: string[]): Record<string, unknown> {
  const catKey = categories[0]
  const numKey = numerics[0]
  if (!catKey || !numKey) return {}

  const xData = rows.map((r) => String(r[catKey] ?? ''))
  const yData = rows.map((r) => Number(r[numKey] ?? 0))
  const label = numKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: '3%', right: '4%', bottom: '8%', containLabel: true },
    xAxis: { type: 'category', data: xData, axisLabel: { rotate: xData.length > 8 ? 30 : 0, overflow: 'truncate', width: 100 } },
    yAxis: { type: 'value', name: label },
    series: [{ name: label, type: 'bar', data: yData, itemStyle: { borderRadius: [3, 3, 0, 0] } }],
  }
}

function buildLineOption(rows: Record<string, unknown>[], timeSeries: string, numerics: string[]): Record<string, unknown> {
  const xData = rows.map((r) => String(r[timeSeries] ?? ''))
  const series = numerics.slice(0, 3).map((numKey) => ({
    name: numKey.replace(/_/g, ' '),
    type: 'line',
    data: rows.map((r) => Number(r[numKey] ?? null)),
    smooth: true,
    showSymbol: rows.length < 50,
  }))

  return {
    tooltip: { trigger: 'axis' },
    legend: { data: series.map((s) => s.name) },
    grid: { left: '3%', right: '4%', bottom: '8%', containLabel: true },
    xAxis: { type: 'category', data: xData, axisLabel: { rotate: 30, overflow: 'truncate', width: 80 } },
    yAxis: { type: 'value' },
    series,
  }
}

function buildScatterOption(rows: Record<string, unknown>[], numerics: string[]): Record<string, unknown> {
  const xKey = numerics[0]
  const yKey = numerics[1]
  if (!xKey || !yKey) return {}

  return {
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', name: xKey.replace(/_/g, ' ') },
    yAxis: { type: 'value', name: yKey.replace(/_/g, ' ') },
    series: [{
      type: 'scatter',
      data: rows.map((r) => [Number(r[xKey]), Number(r[yKey])]),
      symbolSize: 8,
    }],
  }
}

function buildKpiRecommendation(rows: Record<string, unknown>[], numerics: string[]): Partial<VisualizationRecommendation> {
  if (rows.length === 0 || numerics.length === 0) return {}
  const numKey = numerics[0]
  const val = rows[0][numKey]
  return {
    kpiValue: typeof val === 'number' ? Math.round(val * 100) / 100 : String(val ?? '—'),
    kpiLabel: numKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given an AnalysisRequest and a ToolResult, returns a VisualizationRecommendation
 * with the best chart type and a ready-to-use ECharts option.
 */
export function recommendVisualization(
  request: AnalysisRequest,
  result: ToolResult
): VisualizationRecommendation {
  const rows = result.rows as Record<string, unknown>[]
  const { categories, numerics, timeSeries } = sniffColumns(rows)
  const { type: chartType, reason } = inferChartType(rows, request.visualization, request.intent)

  if (chartType === 'table') {
    return { chartType, reason, echartsOption: null }
  }

  if (chartType === 'kpi') {
    return { chartType, reason, echartsOption: null, ...buildKpiRecommendation(rows, numerics) }
  }

  if (chartType === 'line' && timeSeries) {
    return { chartType, reason, echartsOption: buildLineOption(rows, timeSeries, numerics.length > 0 ? numerics : ['value']) }
  }

  if (chartType === 'bar') {
    return { chartType, reason, echartsOption: buildBarOption(rows, categories, numerics) }
  }

  if (chartType === 'scatter') {
    return { chartType, reason, echartsOption: buildScatterOption(rows, numerics) }
  }

  return { chartType: 'table', reason: 'Fallback to table', echartsOption: null }
}
