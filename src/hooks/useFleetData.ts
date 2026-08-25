import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ensureFleetDataLoaded } from '@/lib/fleetDuckdb'
import { useFleetStore } from '@/store/fleetStore'

/**
 * Ensures the bundled fleet dataset is loaded into DuckDB, syncing status
 * into fleetStore. Call this once near the top of any Fleet page.
 */
export function useEnsureFleetData() {
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)
  const setFleetLoaded = useFleetStore((s) => s.setFleetLoaded)
  const setFleetLoading = useFleetStore((s) => s.setFleetLoading)
  const setFleetLoadError = useFleetStore((s) => s.setFleetLoadError)

  const { isLoading, error } = useQuery({
    queryKey: ['fleet-data-load'],
    queryFn: async () => {
      setFleetLoading(true)
      const result = await ensureFleetDataLoaded()
      if (result.error || result.count === 0) {
        setFleetLoadError(result.error ?? 'No fleet data loaded')
      } else {
        setFleetLoaded(result.count)
      }
      return result
    },
    enabled: !isFleetLoaded,
    retry: false,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (error) {
      setFleetLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [error, setFleetLoadError])

  return { isLoading: isLoading && !isFleetLoaded, error }
}
