import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUIStore } from '@/store/uiStore'
import type { MetricKey } from '@/lib/queries'

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: 'dc_power', label: 'DC Power' },
  { value: 'ac_power', label: 'AC Power' },
  { value: 'energy_produced', label: 'Energy Produced' },
  { value: 'temperature_c', label: 'Temperature' },
  { value: 'ac_voltage', label: 'AC Voltage' },
  { value: 'ac_frequency', label: 'AC Frequency' },
  { value: 'dc_current', label: 'DC Current' },
  { value: 'dc_voltage', label: 'DC Voltage' },
]

export default function MetricPicker() {
  const metric = useUIStore((s) => s.metric)
  const setMetric = useUIStore((s) => s.setMetric)

  return (
    <Select
      value={metric}
      onValueChange={(val) => {
        if (val) setMetric(val as MetricKey)
      }}
    >
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {METRIC_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
