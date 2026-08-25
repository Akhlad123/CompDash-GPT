import { useState, useCallback, useEffect } from 'react'
import { CalendarDays } from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/button'
import { useDataStore } from '@/store/dataStore'
import type { DateRange } from '@/store/dataStore'

export default function DateRangePicker() {
  const dateRange = useDataStore((s) => s.dateRange)
  const setDateRange = useDataStore((s) => s.setDateRange)

  const [fromStr, setFromStr] = useState(() => {
    try { return dateRange ? format(dateRange.from, 'yyyy-MM-dd') : '' } catch { return '' }
  })
  const [toStr, setToStr] = useState(() => {
    try { return dateRange ? format(dateRange.to, 'yyyy-MM-dd') : '' } catch { return '' }
  })

  // Sync with store when dateRange changes externally (e.g. after upload)
  useEffect(() => {
    try {
      if (dateRange) {
        setFromStr(format(dateRange.from, 'yyyy-MM-dd'))
        setToStr(format(dateRange.to, 'yyyy-MM-dd'))
      }
    } catch { /* ignore format errors */ }
  }, [dateRange])

  const handleApply = useCallback(() => {
    if (!fromStr || !toStr) return
    // Parse as local date (not UTC) to avoid timezone shift
    const [fy, fm, fd] = fromStr.split('-').map(Number)
    const [ty, tm, td] = toStr.split('-').map(Number)
    const from = new Date(fy, fm - 1, fd)
    const to = new Date(ty, tm - 1, td)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return
    const range: DateRange = { from, to }
    setDateRange(range)
  }, [fromStr, toStr, setDateRange])

  return (
    <div className="flex items-center gap-2">
      <CalendarDays className="h-4 w-4 text-muted-foreground" />
      <input
        type="date"
        value={fromStr}
        onChange={(e) => setFromStr(e.target.value)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
      />
      <span className="text-sm text-muted-foreground">—</span>
      <input
        type="date"
        value={toStr}
        onChange={(e) => setToStr(e.target.value)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
      />
      <Button variant="outline" size="sm" onClick={handleApply}>
        Apply
      </Button>
    </div>
  )
}
