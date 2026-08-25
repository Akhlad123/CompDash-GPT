import { useState, useCallback } from 'react'
import { Wand2, CheckCircle2, AlertCircle } from 'lucide-react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ALL_FIELDS, REQUIRED_FIELDS, buildAutoMapping } from '@/lib/schema'

interface ColumnMapperProps {
  headers: string[]
  initialMapping: Record<string, string>
  onConfirm: (mapping: Record<string, string>) => void
}

const UNMAPPED = '__unmapped__'

export default function ColumnMapper({
  headers,
  initialMapping,
  onConfirm,
}: ColumnMapperProps) {
  const [mapping, setMapping] = useState<Record<string, string>>(initialMapping)

  const unmappedRequired = REQUIRED_FIELDS.filter((f) => !mapping[f.key])

  const handleChange = useCallback((fieldKey: string, csvHeader: string) => {
    setMapping((prev) => {
      const next = { ...prev }
      if (csvHeader === UNMAPPED) {
        delete next[fieldKey]
      } else {
        next[fieldKey] = csvHeader
      }
      return next
    })
  }, [])

  const handleAutoDetect = useCallback(() => {
    setMapping(buildAutoMapping(headers))
  }, [headers])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Column Mapping
          {unmappedRequired.length === 0 ? (
            <Badge variant="default">All mapped</Badge>
          ) : (
            <Badge variant="destructive">
              {unmappedRequired.length} unmapped
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Map your file columns to the required telemetry fields.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleAutoDetect}>
            <Wand2 className="mr-1 h-4 w-4" />
            Auto-detect
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Field</TableHead>
              <TableHead className="w-40">Description</TableHead>
              <TableHead>Mapped Column</TableHead>
              <TableHead className="w-20">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ALL_FIELDS.map((field) => {
              const isRequired = REQUIRED_FIELDS.some((f) => f.key === field.key)
              const mapped = mapping[field.key]
              const isMapped = Boolean(mapped)

              return (
                <TableRow key={field.key}>
                  <TableCell className="font-medium">
                    {field.label}
                    {!isRequired && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (optional)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {field.description}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={isMapped ? mapped : UNMAPPED}
                      onValueChange={(val) => handleChange(field.key, val ?? UNMAPPED)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNMAPPED}>
                          <span className="text-muted-foreground">
                            — Not mapped —
                          </span>
                        </SelectItem>
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {isMapped ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : isRequired ? (
                      <AlertCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>

        {unmappedRequired.length > 0 && (
          <p className="text-sm text-destructive">
            Missing required fields:{' '}
            {unmappedRequired.map((f) => f.label).join(', ')}
          </p>
        )}

        <Button
          onClick={() => onConfirm(mapping)}
          disabled={unmappedRequired.length > 0}
        >
          Confirm Mapping
        </Button>
      </CardContent>
    </Card>
  )
}
