import { useQueries } from '@tanstack/react-query'
import { query } from '@/lib/duckdb'
import { buildTimeseriesQuery } from '@/lib/queries'
import type { MetricKey, Granularity } from '@/lib/queries'
import { useDataStore } from '@/store/dataStore'

export interface MultiMetricTimeSeriesRow {
  bucket: string
  site_id: string
  serial_number: string
  metric_value: number
  sample_count: number
}

export function useMultiMetricTimeSeries(
  siteIds: string[],
  metrics: MetricKey[],
  granularity: Granularity,
  inverterIds: string[] = []
) {
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const dateRange = useDataStore((s) => s.dateRange)

  const results = useQueries({
    queries: metrics.map((metric) => ({
      queryKey: [
        'timeseries',
        metric,
        granularity,
        siteIds,
        inverterIds,
        dateRange?.from?.toISOString(),
        dateRange?.to?.toISOString(),
      ],
      queryFn: () => {
        const sql = buildTimeseriesQuery(metric, granularity, siteIds, inverterIds, dateRange)
        return query<MultiMetricTimeSeriesRow>(sql)
      },
      enabled: isDataLoaded && siteIds.length > 0,
    })),
  })

  return {
    results,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  }
}
