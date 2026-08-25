import { useState } from 'react'
import { Settings2, Plus, Trash2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import type { PowerBinDef } from '@/lib/fleetRegions'

interface PowerBucketEditorProps {
  /** Current effective bin definition (default or previously customized). */
  value: PowerBinDef
  /** The library/region default — used for the Reset action. */
  defaultValue: PowerBinDef
  onSave: (def: PowerBinDef) => void
  onReset: () => void
  triggerLabel?: string
}

interface EditableRow {
  lo: string
  label: string
}

function toEditableRows(def: PowerBinDef): EditableRow[] {
  // Skip the implicit final sentinel edge (99999) — last row's "hi" is always "and above".
  return def.labels.map((label, i) => ({ lo: String(def.bins[i]), label }))
}

/**
 * Dialog for customizing power-bucket bin edges + labels. Used by both the
 * Wafer Detail page (per-region bins) and the Product Bucket page (global
 * bins), since power_block/power_bucket can be recomputed on the fly from
 * raw stc_rating2 via buildPowerBucketCaseSql() — no re-ingest needed.
 */
export default function PowerBucketEditor({
  value, defaultValue, onSave, onReset, triggerLabel = 'Edit Power Buckets',
}: PowerBucketEditorProps) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<EditableRow[]>(() => toEditableRows(value))

  const handleOpenChange = (next: boolean) => {
    if (next) setRows(toEditableRows(value))
    setOpen(next)
  }

  const updateRow = (i: number, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const addRow = () => {
    setRows((prev) => {
      const lastLo = prev.length > 0 ? Number(prev[prev.length - 1].lo) : 0
      return [...prev, { lo: String(lastLo + 25), label: `>${lastLo + 25}` }]
    })
  }

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i))
  }

  const handleSave = () => {
    const sorted = [...rows]
      .map((r) => ({ ...r, loNum: Number(r.lo) }))
      .filter((r) => Number.isFinite(r.loNum))
      .sort((a, b) => a.loNum - b.loNum)

    if (sorted.length === 0) return

    const bins = [sorted[0].loNum, ...sorted.slice(1).map((r) => r.loNum), 99999]
    const labels = sorted.map((r) => r.label.trim() || `${r.loNum}+`)
    onSave({ bins, labels })
    setOpen(false)
  }

  const handleReset = () => {
    onReset()
    setRows(toEditableRows(defaultValue))
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Settings2 className="mr-1.5 h-3.5 w-3.5" />
        {triggerLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Customize Power Buckets</DialogTitle>
          <DialogDescription>
            Define the STC power (W) ranges used to bucket modules. Each row's
            &quot;From (W)&quot; is the lower bound (inclusive); the range extends up to
            the next row&apos;s lower bound.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 space-y-2 overflow-y-auto">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground">
            <span>From (W)</span>
            <span>Label</span>
            <span />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                type="number"
                value={row.lo}
                onChange={(e) => updateRow(i, { lo: e.target.value })}
                className="h-8 text-sm"
              />
              <Input
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                className="h-8 text-sm"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => removeRow(i)}
                disabled={rows.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addRow} className="w-full">
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Bucket
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to Default
          </Button>
          <Button size="sm" onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
