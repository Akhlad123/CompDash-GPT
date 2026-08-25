import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import {
  Upload,
  FileSpreadsheet,
  X,
  Loader2,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import ColumnMapper from '@/components/upload/ColumnMapper'
import SKUMapper from '@/components/upload/SKUMapper'
import DataPreview from '@/components/upload/DataPreview'
import { parseFile } from '@/lib/parsers'
import type { ParseResult } from '@/lib/parsers'
import {
  buildAutoMapping,
  loadMapping,
  saveMapping,
  applyMapping,
} from '@/lib/schema'
import type { TelemetryRow, ValidationWarning } from '@/lib/schema'
import { ingestData } from '@/lib/duckdb'
import { saveSession } from '@/lib/sessionStore'
import { useDataStore } from '@/store/dataStore'
import type { InverterInfo } from '@/store/dataStore'

interface UploadedFile {
  file: File
  result: ParseResult
}

const STEPS = ['Upload Files', 'Map Columns', 'Preview & Load'] as const

export default function UploadPage() {
  const navigate = useNavigate()
  const isDataLoaded = useDataStore((s) => s.isDataLoaded)
  const setDataLoaded = useDataStore((s) => s.setDataLoaded)
  const setSites = useDataStore((s) => s.setSites)
  const setInverters = useDataStore((s) => s.setInverters)
  const setDateRange = useDataStore((s) => s.setDateRange)
  const resetData = useDataStore((s) => s.resetData)

  const [step, setStep] = useState(0)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [parsing, setParsing] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [skuMapping, setSKUMapping] = useState<Record<string, string>>({})
  const [mappedRows, setMappedRows] = useState<TelemetryRow[]>([])
  const [warnings, setWarnings] = useState<ValidationWarning[]>([])
  const [ingesting, setIngesting] = useState(false)
  const [ingestProgress, setIngestProgress] = useState('')

  // ── Step 1: File Drop ──────────────────────────────────────────────────

  const onDrop = useCallback(
    async (accepted: File[]) => {
      setParsing(true)
      const newFiles: UploadedFile[] = []
      for (const file of accepted) {
        try {
          const result = await parseFile(file)
          newFiles.push({ file, result })
        } catch (err) {
          console.error(`Failed to parse ${file.name}:`, err)
        }
      }
      setFiles((prev) => [...prev, ...newFiles])
      setParsing(false)
    },
    []
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    multiple: true,
  })

  const removeFile = useCallback((idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const allHeaders = useMemo(
    () => (files.length > 0 ? files[0].result.headers : []),
    [files]
  )

  const headerMismatch = useMemo(() => {
    if (files.length <= 1) return false
    const baseSet = new Set(files[0].result.headers)
    return files.slice(1).some((f) => {
      const thisSet = new Set(f.result.headers)
      return (
        baseSet.size !== thisSet.size ||
        [...baseSet].some((h) => !thisSet.has(h))
      )
    })
  }, [files])

  const totalRows = useMemo(
    () => files.reduce((sum, f) => sum + f.result.rows.length, 0),
    [files]
  )

  // ── Step 2 → 3 transition: apply mapping ──────────────────────────────

  const handleMappingConfirm = useCallback(
    (confirmed: Record<string, string>) => {
      setMapping(confirmed)
      saveMapping(confirmed)

      const allRows = files.flatMap((f) => f.result.rows)
      const { data, warnings: w } = applyMapping(allRows, confirmed)
      setMappedRows(data)
      setWarnings(w)
      setStep(2)
    },
    [files]
  )

  // ── Preview stats ─────────────────────────────────────────────────────

  const uniqueSites = useMemo(
    () => [...new Set(mappedRows.map((r) => r.site_id).filter(Boolean))],
    [mappedRows]
  )

  const uniqueSerials = useMemo(
    () => [...new Set(mappedRows.map((r) => r.serial_number).filter(Boolean))],
    [mappedRows]
  )

  // ── Load into DuckDB ──────────────────────────────────────────────────

  const handleLoadData = useCallback(async () => {
    setIngesting(true)
    try {
      setIngestProgress('Preparing rows…')

      const rowsWithSKU = mappedRows.map((r) => ({
        ...r,
        sku_name: skuMapping[r.serial_number] ?? r.sku_name,
      }))

      setIngestProgress('Initializing DuckDB…')
      await ingestData(rowsWithSKU as Record<string, unknown>[])

      setIngestProgress('Updating store…')

      const sites = [...new Set(rowsWithSKU.map((r) => r.site_id).filter(Boolean))]
      const inverterMap = new Map<string, InverterInfo>()
      for (const row of rowsWithSKU) {
        if (!inverterMap.has(row.serial_number)) {
          inverterMap.set(row.serial_number, {
            serial_number: row.serial_number,
            site_id: row.site_id,
            sku_name: row.sku_name,
          })
        }
      }

      const timestamps = rowsWithSKU
        .map((r) => r.timestamp)
        .filter(Boolean)
        .sort()

      setSites(sites)
      setInverters([...inverterMap.values()])
      if (timestamps.length > 0) {
        setDateRange({
          from: new Date(timestamps[0]),
          to: new Date(timestamps[timestamps.length - 1]),
        })
      }
      setDataLoaded(true)
      setIngestProgress('Done!')
      navigate('/overview')

      saveSession(
        rowsWithSKU,
        sites,
        [...inverterMap.values()],
        timestamps.length > 0
          ? { from: new Date(timestamps[0]), to: new Date(timestamps[timestamps.length - 1]) }
          : null
      ).catch((err) => console.warn('Session save failed (non-critical):', err))
    } catch (err) {
      console.error('Ingest failed:', err)
      setIngestProgress(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIngesting(false)
    }
  }, [
    mappedRows,
    skuMapping,
    navigate,
    setSites,
    setInverters,
    setDateRange,
    setDataLoaded,
  ])

  // ── Navigation helpers ────────────────────────────────────────────────

  const goToStep2 = useCallback(() => {
    const saved = loadMapping()
    const auto = buildAutoMapping(allHeaders)
    setMapping(saved ?? auto)
    setStep(1)
  }, [allHeaders])

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Upload Data</h1>

      {isDataLoaded && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Data already loaded. Upload new data to replace.
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => {
              resetData()
              setFiles([])
              setMappedRows([])
              setStep(0)
            }}
          >
            Reset
          </Button>
        </div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-3">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && <Separator className="w-8" />}
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                i === step
                  ? 'bg-primary text-primary-foreground'
                  : i < step
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </div>
            <span
              className={`text-sm ${
                i === step ? 'font-medium' : 'text-muted-foreground'
              }`}
            >
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* ── Step 1: File Drop ──────────────────────────────────────── */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5" />
              Upload Telemetry Files
            </CardTitle>
            <CardDescription>
              Drop CSV or Excel files. Multiple files will be merged.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              {...getRootProps()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors ${
                isDragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
            >
              <input {...getInputProps()} />
              <FileSpreadsheet className="mb-3 h-10 w-10 text-muted-foreground" />
              {isDragActive ? (
                <p className="text-sm font-medium">Drop files here…</p>
              ) : (
                <>
                  <p className="text-sm font-medium">
                    Drag & drop files here, or click to browse
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Accepts .csv, .xlsx, .xls
                  </p>
                </>
              )}
            </div>

            {parsing && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Parsing files…
              </div>
            )}

            {files.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {files.length} file{files.length > 1 ? 's' : ''} ·{' '}
                  {totalRows.toLocaleString()} total rows
                </p>
                <div className="flex flex-wrap gap-2">
                  {files.map((f, idx) => (
                    <Badge
                      key={`${f.file.name}-${idx}`}
                      variant="secondary"
                      className="gap-1.5 pr-1"
                    >
                      <FileSpreadsheet className="h-3 w-3" />
                      {f.file.name}
                      <span className="text-muted-foreground">
                        ({f.result.rows.length.toLocaleString()} rows)
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          removeFile(idx)
                        }}
                        className="ml-1 rounded p-0.5 hover:bg-muted"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={goToStep2}
                disabled={files.length === 0 || parsing}
              >
                Next: Map Columns
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Step 2: Column Mapping ─────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          {headerMismatch && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Column headers differ between uploaded files. Mapping uses the
              first file&apos;s headers.
            </div>
          )}

          <ColumnMapper
            headers={allHeaders}
            initialMapping={mapping}
            onConfirm={handleMappingConfirm}
          />

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: SKU + Preview ──────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-4">
          <SKUMapper
            serialNumbers={uniqueSerials}
            onConfirm={(m) => setSKUMapping(m)}
          />

          <DataPreview
            rows={mappedRows}
            warnings={warnings}
            sites={uniqueSites}
            inverters={uniqueSerials}
            onLoadData={handleLoadData}
            loading={ingesting}
          />

          {(ingesting || ingestProgress.startsWith('Error')) && (
            <Card className={ingestProgress.startsWith('Error') ? 'border-red-300' : ''}>
              <CardContent className="flex flex-col items-center gap-3 py-6">
                {ingesting && <Loader2 className="h-8 w-8 animate-spin text-primary" />}
                <p className={`text-sm font-medium ${ingestProgress.startsWith('Error') ? 'text-red-600' : ''}`}>
                  {ingestProgress}
                </p>
                {ingesting && <Progress value={null} className="w-64" />}
              </CardContent>
            </Card>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
