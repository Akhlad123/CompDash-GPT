import { useState, useCallback, useRef } from 'react'
import { Plus, Trash2, Upload, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import Papa from 'papaparse'

interface SKUMapperProps {
  serialNumbers: string[]
  onConfirm: (mapping: Record<string, string>) => void
}

interface SKUEntry {
  serial: string
  sku: string
}

export default function SKUMapper({ serialNumbers, onConfirm }: SKUMapperProps) {
  const [expanded, setExpanded] = useState(false)
  const [entries, setEntries] = useState<SKUEntry[]>(() =>
    serialNumbers.slice(0, 5).map((s) => ({ serial: s, sku: '' }))
  )
  const fileRef = useRef<HTMLInputElement>(null)

  const handleSerialChange = useCallback((idx: number, value: string) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, serial: value } : e)))
  }, [])

  const handleSKUChange = useCallback((idx: number, value: string) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, sku: value } : e)))
  }, [])

  const addRow = useCallback(() => {
    setEntries((prev) => [...prev, { serial: '', sku: '' }])
  }, [])

  const removeRow = useCallback((idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const handleCSVUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const cols = results.meta.fields ?? []
          const serialCol = cols[0] ?? ''
          const skuCol = cols[1] ?? ''

          if (!serialCol || !skuCol) return

          const parsed: SKUEntry[] = results.data
            .filter((row) => row[serialCol] && row[skuCol])
            .map((row) => ({
              serial: row[serialCol].trim(),
              sku: row[skuCol].trim(),
            }))

          if (parsed.length > 0) {
            setEntries(parsed)
          }
        },
      })

      e.target.value = ''
    },
    []
  )

  const handleApply = useCallback(() => {
    const mapping: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.serial && entry.sku) {
        mapping[entry.serial] = entry.sku
      }
    }
    onConfirm(mapping)
  }, [entries, onConfirm])

  const handleSkip = useCallback(() => {
    onConfirm({})
  }, [onConfirm])

  return (
    <Card>
      <CardHeader
        className="cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <CardTitle className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Map Microinverter Models (Optional)
        </CardTitle>
        <CardDescription>
          Assign SKU / model names to serial numbers for labeling.
        </CardDescription>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="mr-1 h-4 w-4" />
              Add Row
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-1 h-4 w-4" />
              Upload Mapping CSV
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCSVUpload}
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Serial Number</TableHead>
                <TableHead>SKU / Model Name</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, idx) => (
                <TableRow key={idx}>
                  <TableCell>
                    <input
                      className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                      value={entry.serial}
                      onChange={(e) =>
                        handleSerialChange(idx, e.target.value)
                      }
                      placeholder="123456789012"
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                      value={entry.sku}
                      onChange={(e) =>
                        handleSKUChange(idx, e.target.value)
                      }
                      placeholder="IQ8HC"
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeRow(idx)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSkip}>
              Skip
            </Button>
            <Button onClick={handleApply}>Apply</Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
