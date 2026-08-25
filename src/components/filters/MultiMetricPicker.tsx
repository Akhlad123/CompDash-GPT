import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { X } from 'lucide-react'
import type { MetricKey } from '@/lib/queries'

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: 'dc_power', label: 'DC Power' },
  { value: 'ac_power', label: 'AC Power' },
  { value: 'energy_produced', label: 'Energy' },
  { value: 'temperature_c', label: 'Temperature' },
  { value: 'ac_voltage', label: 'AC Voltage' },
  { value: 'ac_frequency', label: 'AC Frequency' },
  { value: 'dc_current', label: 'DC Current' },
  { value: 'dc_voltage', label: 'DC Voltage' },
]

interface MultiMetricPickerProps {
  selected: MetricKey[]
  onChange: (metrics: MetricKey[]) => void
  max?: number
}

export default function MultiMetricPicker({
  selected,
  onChange,
  max = 4,
}: MultiMetricPickerProps) {
  const available = METRIC_OPTIONS.filter((o) => !selected.includes(o.value))

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium text-muted-foreground">Metrics:</span>
      {selected.map((m) => {
        const opt = METRIC_OPTIONS.find((o) => o.value === m)
        return (
          <Badge key={m} variant="secondary" className="gap-1 pr-1">
            {opt?.label ?? m}
            <button
              className="ml-1 rounded-full p-0.5 hover:bg-muted"
              onClick={() => onChange(selected.filter((s) => s !== m))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}
      {selected.length < max && available.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {available.map((opt) => (
            <Button
              key={opt.value}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onChange([...selected, opt.value])}
            >
              + {opt.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
