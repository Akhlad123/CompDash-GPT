import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useDropzone } from 'react-dropzone'
import { Upload, FileSpreadsheet, CheckCircle, AlertTriangle, ArrowRight, Database, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { loadFleetFromFile, type FleetLoadResult } from '@/lib/fleetDuckdb'
import { loadRmaFromFile, type RmaLoadResult } from '@/lib/rmaDuckdb'

interface UploadCardProps {
  title: string
  description: string
  accept: string
  file: File | null
  result: FleetLoadResult | RmaLoadResult | null
  loading: boolean
  onDrop: (file: File) => void
  onReset: () => void
  icon: React.ReactNode
}

function formatCount(n: number): string {
  return n.toLocaleString()
}

function UploadCard({ title, description, accept, file, result, loading, onDrop, onReset, icon }: UploadCardProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { [accept]: ['.parquet'] },
    multiple: false,
    onDrop: (accepted) => {
      if (accepted[0]) onDrop(accepted[0])
    },
    disabled: loading,
  })

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {!file ? (
          <div
            {...getRootProps()}
            className={`flex flex-1 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors ${
              isDragActive
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            } ${loading ? 'pointer-events-none opacity-60' : ''}`}
          >
            <input {...getInputProps()} />
            <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
            <p className="text-center text-sm font-medium">
              {isDragActive ? 'Drop the parquet file here' : 'Drag & drop or click to upload'}
            </p>
            <p className="mt-1 text-center text-xs text-muted-foreground">Expected filename: {accept}</p>
          </div>
        ) : (
          <div className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="h-6 w-6 text-primary" />
                <div>
                  <p className="text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={onReset} disabled={loading}>
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>

            {loading && (
              <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Ingesting into DuckDB-WASM…
              </div>
            )}

            {result && !loading && (
              <div className="mt-3 space-y-1 text-sm">
                {result.error ? (
                  <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-4 w-4" />
                    {result.error}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                      <CheckCircle className="h-4 w-4" />
                      Loaded {formatCount(result.count)} rows from {result.source}
                    </div>
                    {result.source === 'file' && (
                      <p className="text-xs text-muted-foreground">Data remains in this browser tab only.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function DataUploadPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [fleetFile, setFleetFile] = useState<File | null>(null)
  const [fleetResult, setFleetResult] = useState<FleetLoadResult | null>(null)
  const [fleetLoading, setFleetLoading] = useState(false)

  const [rmaFile, setRmaFile] = useState<File | null>(null)
  const [rmaResult, setRmaResult] = useState<RmaLoadResult | null>(null)
  const [rmaLoading, setRmaLoading] = useState(false)

  const handleFleetDrop = useCallback(async (file: File) => {
    setFleetFile(file)
    setFleetLoading(true)
    try {
      const result = await loadFleetFromFile(file)
      setFleetResult(result)
      if (result.count > 0) {
        queryClient.invalidateQueries({ queryKey: ['fleet-data-load'] })
      }
    } finally {
      setFleetLoading(false)
    }
  }, [queryClient])

  const handleRmaDrop = useCallback(async (file: File) => {
    setRmaFile(file)
    setRmaLoading(true)
    try {
      const result = await loadRmaFromFile(file)
      setRmaResult(result)
      if (result.count > 0) {
        queryClient.invalidateQueries({ queryKey: ['rma-data-load'] })
      }
    } finally {
      setRmaLoading(false)
    }
  }, [queryClient])

  const resetFleet = useCallback(() => {
    setFleetFile(null)
    setFleetResult(null)
  }, [])

  const resetRma = useCallback(() => {
    setRmaFile(null)
    setRmaResult(null)
  }, [])

  const fleetOk = fleetResult != null && fleetResult.count > 0 && !fleetResult.error
  const rmaOk = rmaResult != null && rmaResult.count > 0 && !rmaResult.error
  const ready = fleetOk && rmaOk

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Load Fleet & RMA Data</h1>
        <p className="text-sm text-muted-foreground">
          Upload the proprietary <code>fleet_data.parquet</code> and <code>rma_data.parquet</code> files.{' '}
          <strong>Files stay in your browser only</strong> — DuckDB-WASM processes them locally.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <UploadCard
          title="Fleet Data"
          description="Site roster, modules, irradiance, and grid profile data."
          accept="fleet_data.parquet"
          file={fleetFile}
          result={fleetResult}
          loading={fleetLoading}
          onDrop={handleFleetDrop}
          onReset={resetFleet}
          icon={<Database className="h-5 w-5" />}
        />
        <UploadCard
          title="RMA Data"
          description="Return and replacement requests by site."
          accept="rma_data.parquet"
          file={rmaFile}
          result={rmaResult}
          loading={rmaLoading}
          onDrop={handleRmaDrop}
          onReset={resetRma}
          icon={<FileSpreadsheet className="h-5 w-5" />}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-4">
        <div className="flex items-center gap-3">
          <Badge variant={fleetOk ? 'default' : 'secondary'}>{fleetOk ? 'Fleet Ready' : 'Fleet Missing'}</Badge>
          <Badge variant={rmaOk ? 'default' : 'secondary'}>{rmaOk ? 'RMA Ready' : 'RMA Missing'}</Badge>
        </div>
        <Button onClick={() => navigate('/fleet/query')} disabled={!ready}>
          Go to Ask a Question
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Tip: For local development, place these files in <code>public/fleet-data/</code> and the app will load them
        automatically. They are gitignored and will not be committed.
      </p>
    </div>
  )
}
