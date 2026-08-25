import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/uiStore'
import type { Granularity } from '@/lib/queries'

const OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'raw', label: 'Raw' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
]

export default function GranularityToggle() {
  const granularity = useUIStore((s) => s.granularity)
  const setGranularity = useUIStore((s) => s.setGranularity)

  return (
    <div className="flex items-center gap-1 rounded-lg border p-1">
      {OPTIONS.map((opt) => (
        <Button
          key={opt.value}
          variant={granularity === opt.value ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setGranularity(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  )
}
