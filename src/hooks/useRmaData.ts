import { useQuery } from '@tanstack/react-query'
import { ensureRmaDataLoaded } from '@/lib/rmaDuckdb'

/**
 * Ensures the bundled RMA dataset is loaded into DuckDB.
 * Returns loading state. Safe to call multiple times — the
 * underlying fetch+ingest only runs once per session.
 */
export function useEnsureRmaData() {
  const { data: rmaResult, isLoading, error } = useQuery({
    queryKey: ['rma-data-load'],
    queryFn: () => ensureRmaDataLoaded(),
    retry: false,
    staleTime: Infinity,
  })

  return {
    isRmaLoaded: rmaResult != null && rmaResult.count > 0 && rmaResult.error == null,
    isRmaLoading: isLoading,
    rmaCount: rmaResult?.count ?? 0,
    rmaError: error ?? (rmaResult?.error ? new Error(rmaResult.error) : null),
    rmaSource: rmaResult?.source ?? null,
  }
}
