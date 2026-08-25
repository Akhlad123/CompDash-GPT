import { Outlet, useNavigate } from 'react-router-dom'
import { Loader2, Database, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEnsureFleetData } from '@/hooks/useFleetData'
import { useEnsureRmaData } from '@/hooks/useRmaData'
import { useFleetStore } from '@/store/fleetStore'

export default function FleetDataGate() {
  const navigate = useNavigate()
  const { isLoading: fleetLoading } = useEnsureFleetData()
  const { isRmaLoading, isRmaLoaded } = useEnsureRmaData()
  const isFleetLoaded = useFleetStore((s) => s.isFleetLoaded)
  const fleetLoadError = useFleetStore((s) => s.fleetLoadError)

  const loading = fleetLoading || isRmaLoading

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading fleet & RMA data…
      </div>
    )
  }

  if (!isFleetLoaded || !isRmaLoaded) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 p-6 text-center">
        <div className="flex justify-center">
          <div className="rounded-full bg-amber-100 p-4 dark:bg-amber-900">
            <Database className="h-8 w-8 text-amber-600 dark:text-amber-300" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Fleet/RMA data not loaded</h2>
          <p className="text-sm text-muted-foreground">
            {fleetLoadError ?? 'Upload the Fleet and RMA parquet files to use Fleet Analytics and Ask a Question.'}
          </p>
        </div>
        <Button onClick={() => navigate('/data')}>
          <Upload className="mr-2 h-4 w-4" />
          Upload Data
        </Button>
        <p className="text-xs text-muted-foreground">
          For local development, place <code>fleet_data.parquet</code> and <code>rma_data.parquet</code> in{' '}
          <code>public/fleet-data/</code>.
        </p>
      </div>
    )
  }

  return <Outlet />
}
