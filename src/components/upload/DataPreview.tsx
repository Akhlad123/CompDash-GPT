import { useMemo } from 'react'
import { Database, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { TelemetryRow, ValidationWarning } from '@/lib/schema'

interface DataPreviewProps {
  rows: TelemetryRow[]
  warnings: ValidationWarning[]
  sites: string[]
  inverters: string[]
  onLoadData: () => void
  loading?: boolean
}

const PREVIEW_COLUMNS: { key: keyof TelemetryRow; label: string }[] = [
  { key: 'serial_number', label: 'Serial' },
  { key: 'site_id', label: 'Site' },
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'dc_voltage', label: 'DC V' },
  { key: 'dc_current', label: 'DC A' },
  { key: 'ac_voltage', label: 'AC V' },
  { key: 'energy_produced', label: 'Energy (kWh)' },
  { key: 'temperature_f', label: 'Temp (F)' },
]

export default function DataPreview({
  rows,
  warnings,
  sites,
  inverters,
  onLoadData,
  loading = false,
}: DataPreviewProps) {
  const dateRange = useMemo(() => {
    const timestamps = rows
      .map((r) => r.timestamp)
      .filter(Boolean)
      .sort()
    if (timestamps.length === 0) return null
    return { from: timestamps[0], to: timestamps[timestamps.length - 1] }
  }, [rows])

  const limitedWarnings = warnings.slice(0, 20)
  const hasWarnings = warnings.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Data Preview
          {hasWarnings ? (
            <Badge variant="destructive">{warnings.length} warnings</Badge>
          ) : (
            <Badge variant="default">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Clean
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Review parsed data before loading into DuckDB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Total Rows</p>
            <p className="text-2xl font-semibold">{rows.length.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Unique Sites</p>
            <p className="text-2xl font-semibold">{sites.length}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Unique Inverters</p>
            <p className="text-2xl font-semibold">{inverters.length}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Date Range</p>
            <p className="text-sm font-medium">
              {dateRange ? `${dateRange.from} — ${dateRange.to}` : 'N/A'}
            </p>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                {PREVIEW_COLUMNS.map((col) => (
                  <TableHead key={col.key}>{col.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, 10).map((row, idx) => (
                <TableRow key={idx}>
                  <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                  {PREVIEW_COLUMNS.map((col) => (
                    <TableCell key={col.key} className="font-mono text-xs">
                      {row[col.key] !== null && row[col.key] !== undefined
                        ? String(row[col.key])
                        : '—'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {hasWarnings && (
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <h4 className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Validation Warnings ({warnings.length})
            </h4>
            <ul className="space-y-1 text-xs text-destructive/80">
              {limitedWarnings.map((w, i) => (
                <li key={i}>
                  Row {w.row} — <strong>{w.field}</strong>: {w.message}
                </li>
              ))}
              {warnings.length > 20 && (
                <li className="text-muted-foreground">
                  … and {warnings.length - 20} more
                </li>
              )}
            </ul>
          </div>
        )}

        <Button onClick={onLoadData} disabled={loading || rows.length === 0}>
          {loading ? 'Loading…' : `Load ${rows.length.toLocaleString()} Rows into DuckDB`}
        </Button>
      </CardContent>
    </Card>
  )
}
